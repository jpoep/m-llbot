import * as aws from "@pulumi/aws"
import * as pulumi from "@pulumi/pulumi"

const NAME = "muellbot"
const config = new pulumi.Config()

// The token is only needed for a real deployment; previews work without it.
const botToken =
	config.getSecret("telegramBotToken") ??
	(pulumi.runtime.isDryRun()
		? pulumi.secret("preview-placeholder")
		: config.requireSecret("telegramBotToken"))
const joinCode = config.requireSecret("joinCode")

const accountId = aws.getCallerIdentityOutput().accountId
const region = aws.getRegionOutput().region

// ---------------------------------------------------------------------------
// State: one small JSON document. Provisioned capacity stays inside the always-free tier
// (25 RCU / 25 WCU per account); on-demand would cost a few cents per month instead.
// ---------------------------------------------------------------------------
const table = new aws.dynamodb.Table("state", {
	name: `${NAME}-state`,
	billingMode: "PROVISIONED",
	readCapacity: 3,
	writeCapacity: 3,
	hashKey: "pk",
	attributes: [{ name: "pk", type: "S" }],
	pointInTimeRecovery: { enabled: true },
	deletionProtectionEnabled: true,
})

// ---------------------------------------------------------------------------
// Lambda functions (one bundle, two handlers)
// ---------------------------------------------------------------------------
const functions = ["webhook", "tick"] as const
type FunctionName = (typeof functions)[number]

const logGroups = Object.fromEntries(
	functions.map((fn) => [
		fn,
		new aws.cloudwatch.LogGroup(`${fn}-logs`, {
			name: `/aws/lambda/${NAME}-${fn}`,
			retentionInDays: 14,
		}),
	]),
) as Record<FunctionName, aws.cloudwatch.LogGroup>

const lambdaRole = new aws.iam.Role("lambda-role", {
	name: `${NAME}-lambda`,
	assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
})

new aws.iam.RolePolicy("lambda-policy", {
	role: lambdaRole.id,
	policy: pulumi.jsonStringify({
		Version: "2012-10-17",
		Statement: [
			{
				Sid: "HouseholdState",
				Effect: "Allow",
				Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
				Resource: table.arn,
			},
			{
				Sid: "OwnLogsOnly",
				Effect: "Allow",
				Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
				Resource: functions.map((fn) => pulumi.interpolate`${logGroups[fn].arn}:*`),
			},
		],
	}),
})

const code = new pulumi.asset.AssetArchive({
	"index.mjs": new pulumi.asset.FileAsset("../dist/index.mjs"),
	"index.mjs.map": new pulumi.asset.FileAsset("../dist/index.mjs.map"),
})

const makeFunction = (fn: FunctionName, timeout: number) =>
	new aws.lambda.Function(
		fn,
		{
			name: `${NAME}-${fn}`,
			runtime: aws.lambda.Runtime.NodeJS24dX,
			architectures: ["arm64"],
			handler: `index.${fn}`,
			code,
			role: lambdaRole.arn,
			memorySize: 256,
			timeout,
			loggingConfig: { logFormat: "Text", logGroup: logGroups[fn].name },
			environment: {
				variables: {
					TABLE_NAME: table.name,
					TELEGRAM_BOT_TOKEN: botToken,
					JOIN_CODE: joinCode,
					NODE_OPTIONS: "--enable-source-maps",
				},
			},
		},
		{ dependsOn: [logGroups[fn]] },
	)

const webhook = makeFunction("webhook", 30)
const tick = makeFunction("tick", 50)

// ---------------------------------------------------------------------------
// Public webhook endpoint for Telegram. Free, unlike API Gateway. Requests are authenticated by
// the secret token header that Telegram sends (checked in the handler before anything else).
// ---------------------------------------------------------------------------
const webhookUrl = new aws.lambda.FunctionUrl("webhook-url", {
	functionName: webhook.name,
	authorizationType: "NONE",
})

// Function URLs need both permissions; the second one only applies to calls via the URL.
new aws.lambda.Permission("webhook-url-public", {
	function: webhook.name,
	action: "lambda:InvokeFunctionUrl",
	principal: "*",
	functionUrlAuthType: "NONE",
})
new aws.lambda.Permission("webhook-url-invoke", {
	function: webhook.name,
	action: "lambda:InvokeFunction",
	principal: "*",
	invokedViaFunctionUrl: true,
})

// ---------------------------------------------------------------------------
// Per-minute tick: ~43k invocations/month, far inside the free tiers of Scheduler and Lambda.
// ---------------------------------------------------------------------------
const schedulerRole = new aws.iam.Role("scheduler-role", {
	name: `${NAME}-scheduler`,
	assumeRolePolicy: pulumi.jsonStringify({
		Version: "2012-10-17",
		Statement: [
			{
				Effect: "Allow",
				Principal: { Service: "scheduler.amazonaws.com" },
				Action: "sts:AssumeRole",
				Condition: { StringEquals: { "aws:SourceAccount": accountId } },
			},
		],
	}),
})

new aws.iam.RolePolicy("scheduler-policy", {
	role: schedulerRole.id,
	policy: pulumi.jsonStringify({
		Version: "2012-10-17",
		Statement: [{ Effect: "Allow", Action: "lambda:InvokeFunction", Resource: tick.arn }],
	}),
})

new aws.scheduler.Schedule("tick", {
	name: `${NAME}-tick`,
	description: "Runs the reminder loop once per minute",
	scheduleExpression: "cron(* * * * ? *)",
	scheduleExpressionTimezone: "Europe/Berlin",
	flexibleTimeWindow: { mode: "OFF" },
	target: {
		arn: tick.arn,
		roleArn: schedulerRole.arn,
		// A stale tick is worthless – the next one comes a minute later anyway.
		retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 60 },
	},
})

export const webhookFunctionUrl = webhookUrl.functionUrl
export { webhookFunctionUrl as webhookUrl }
export const tableName = table.name
export const deployedTo = pulumi.interpolate`${accountId} / ${region}`

// ---------------------------------------------------------------------------
// GitHub Actions deploy role (OIDC, no stored AWS keys). Created by the first local `pulumi up`.
// CI may manage the bot's resources but has read-only access to this role and its policy, so a
// compromised workflow cannot widen its own permissions. Changes to this block must be applied
// locally with admin credentials.
// ---------------------------------------------------------------------------
const githubRepository = config.get("githubRepository")
const githubEnvironment = config.get("githubEnvironment") ?? "production"

const arn = (service: string, resource: string) =>
	pulumi.interpolate`arn:aws:${service}:${region}:${accountId}:${resource}`

export const githubDeployRoleArn = githubRepository
	? (() => {
			const oidcUrl = "https://token.actions.githubusercontent.com"
			const oidcProviderArn = config.getBoolean("createGithubOidcProvider")
				? new aws.iam.OpenIdConnectProvider("github-oidc", {
						url: oidcUrl,
						clientIdLists: ["sts.amazonaws.com"],
					}).arn
				: aws.iam.getOpenIdConnectProviderOutput({ url: oidcUrl }).arn

			const deployRoleName = `${NAME}-github-deploy`
			const managedRoles = [lambdaRole, schedulerRole]

			const deployRole = new aws.iam.Role("github-deploy-role", {
				name: deployRoleName,
				description: `GitHub Actions deployments of ${githubRepository} (${githubEnvironment})`,
				maxSessionDuration: 3600,
				assumeRolePolicy: pulumi.jsonStringify({
					Version: "2012-10-17",
					Statement: [
						{
							Effect: "Allow",
							Principal: { Federated: oidcProviderArn },
							Action: "sts:AssumeRoleWithWebIdentity",
							Condition: {
								StringEquals: {
									"token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
									"token.actions.githubusercontent.com:sub": `repo:${githubRepository}:environment:${githubEnvironment}`,
								},
							},
						},
					],
				}),
			})

			new aws.iam.RolePolicy("github-deploy-policy", {
				role: deployRole.id,
				policy: pulumi.jsonStringify({
					Version: "2012-10-17",
					Statement: [
						{
							Sid: "Table",
							Effect: "Allow",
							Action: [
								"dynamodb:Describe*",
								"dynamodb:ListTagsOfResource",
								"dynamodb:GetResourcePolicy",
								"dynamodb:CreateTable",
								"dynamodb:UpdateTable",
								"dynamodb:UpdateContinuousBackups",
								"dynamodb:TagResource",
								"dynamodb:UntagResource",
							],
							Resource: table.arn,
						},
						{
							Sid: "Functions",
							Effect: "Allow",
							Action: [
								"lambda:Get*",
								"lambda:List*",
								"lambda:CreateFunction",
								"lambda:DeleteFunction",
								"lambda:UpdateFunctionCode",
								"lambda:UpdateFunctionConfiguration",
								"lambda:AddPermission",
								"lambda:RemovePermission",
								"lambda:CreateFunctionUrlConfig",
								"lambda:UpdateFunctionUrlConfig",
								"lambda:DeleteFunctionUrlConfig",
								"lambda:TagResource",
								"lambda:UntagResource",
							],
							Resource: arn("lambda", `function:${NAME}-*`),
						},
						{
							Sid: "LogGroups",
							Effect: "Allow",
							Action: [
								"logs:CreateLogGroup",
								"logs:DeleteLogGroup",
								"logs:PutRetentionPolicy",
								"logs:DeleteRetentionPolicy",
								"logs:TagResource",
								"logs:UntagResource",
								"logs:TagLogGroup",
								"logs:UntagLogGroup",
								"logs:ListTagsForResource",
								"logs:ListTagsLogGroup",
							],
							Resource: [
								arn("logs", `log-group:/aws/lambda/${NAME}-*`),
								arn("logs", `log-group:/aws/lambda/${NAME}-*:*`),
							],
						},
						{
							Sid: "DescribeLogGroups",
							Effect: "Allow",
							Action: "logs:DescribeLogGroups",
							Resource: "*",
						},
						{
							Sid: "Schedule",
							Effect: "Allow",
							Action: [
								"scheduler:GetSchedule",
								"scheduler:CreateSchedule",
								"scheduler:UpdateSchedule",
								"scheduler:DeleteSchedule",
								"scheduler:ListTagsForResource",
								"scheduler:TagResource",
								"scheduler:UntagResource",
							],
							Resource: arn("scheduler", `schedule/default/${NAME}-tick`),
						},
						{
							Sid: "BotRoles",
							Effect: "Allow",
							Action: [
								"iam:GetRole",
								"iam:GetRolePolicy",
								"iam:ListRolePolicies",
								"iam:ListAttachedRolePolicies",
								"iam:ListInstanceProfilesForRole",
								"iam:ListRoleTags",
								"iam:CreateRole",
								"iam:DeleteRole",
								"iam:UpdateRole",
								"iam:UpdateRoleDescription",
								"iam:UpdateAssumeRolePolicy",
								"iam:PutRolePolicy",
								"iam:DeleteRolePolicy",
								"iam:TagRole",
								"iam:UntagRole",
							],
							Resource: managedRoles.map((r) => r.arn),
						},
						{
							Sid: "PassBotRoles",
							Effect: "Allow",
							Action: "iam:PassRole",
							Resource: managedRoles.map((r) => r.arn),
							Condition: {
								StringEquals: {
									"iam:PassedToService": ["lambda.amazonaws.com", "scheduler.amazonaws.com"],
								},
							},
						},
						{
							Sid: "ReadOwnRole",
							Effect: "Allow",
							Action: [
								"iam:GetRole",
								"iam:GetRolePolicy",
								"iam:ListRolePolicies",
								"iam:ListAttachedRolePolicies",
								"iam:ListRoleTags",
							],
							Resource: pulumi.interpolate`arn:aws:iam::${accountId}:role/${deployRoleName}`,
						},
						{
							Sid: "ReadGithubOidcProvider",
							Effect: "Allow",
							Action: ["iam:GetOpenIDConnectProvider", "iam:ListOpenIDConnectProviders"],
							Resource: "*",
						},
					],
				}),
			})
			return deployRole.arn
		})()
	: undefined
