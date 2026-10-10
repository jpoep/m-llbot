import {
	ConditionalCheckFailedException,
	DynamoDBClient,
	GetItemCommand,
	PutItemCommand,
} from "@aws-sdk/client-dynamodb"
import { Config, Context, Data, Effect, Layer, Ref, Schema } from "effect"
import { State, upgradeLegacyDocument } from "../domain/model.ts"

/** Another invocation saved a newer version in the meantime. Safe to retry. */
export class Conflict extends Data.TaggedError("Conflict") {}

export class StoreError extends Data.TaggedError("StoreError")<{ readonly cause: unknown }> {}

export interface Versioned {
	/** `undefined` if nothing was stored yet. */
	readonly state: State | undefined
	/** 0 if nothing was stored yet. */
	readonly version: number
}

/**
 * The whole household lives in a single document – a few KB for a handful of people and tasks.
 * Concurrent writers (webhook vs. tick) are serialized with optimistic locking on `version`.
 */
export class StateStore extends Context.Service<
	StateStore,
	{
		readonly load: Effect.Effect<Versioned, StoreError>
		readonly save: (
			state: State,
			expectedVersion: number,
		) => Effect.Effect<void, Conflict | StoreError>
	}
>()("StateStore") {}

const StateJson = Schema.fromJsonString(State)
const decodeState = (json: string) =>
	Effect.try({ try: () => upgradeLegacyDocument(JSON.parse(json)), catch: (cause) => cause }).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(State)),
	)
const encodeState = Schema.encodeEffect(StateJson)

const ITEM_KEY = { pk: { S: "household" } } as const

export const DynamoStateStore = Layer.effect(
	StateStore,
	Effect.gen(function* () {
		const tableName = yield* Config.String("TABLE_NAME")
		const client = new DynamoDBClient({})

		const load = Effect.gen(function* () {
			const response = yield* Effect.tryPromise({
				try: () =>
					client.send(
						new GetItemCommand({ TableName: tableName, Key: ITEM_KEY, ConsistentRead: true }),
					),
				catch: (cause) => new StoreError({ cause }),
			})
			const item = response.Item
			if (item?.["doc"]?.S === undefined) {
				return { state: undefined, version: 0 }
			}
			const state = yield* decodeState(item["doc"].S).pipe(
				Effect.mapError((cause) => new StoreError({ cause })),
			)
			return { state, version: Number(item["version"]?.N ?? 0) }
		})

		const save = (state: State, expectedVersion: number) =>
			Effect.gen(function* () {
				const doc = yield* encodeState(state).pipe(
					Effect.mapError((cause) => new StoreError({ cause })),
				)
				yield* Effect.tryPromise({
					try: () =>
						client.send(
							new PutItemCommand({
								TableName: tableName,
								Item: {
									...ITEM_KEY,
									doc: { S: doc },
									version: { N: String(expectedVersion + 1) },
								},
								ConditionExpression:
									expectedVersion === 0 ? "attribute_not_exists(pk)" : "version = :expected",
								...(expectedVersion === 0
									? {}
									: { ExpressionAttributeValues: { ":expected": { N: String(expectedVersion) } } }),
							}),
						),
					catch: (cause) =>
						cause instanceof ConditionalCheckFailedException
							? new Conflict()
							: new StoreError({ cause }),
				})
			})

		return { load, save }
	}),
)

/** In-memory store for tests and local experiments. */
export const InMemoryStateStore = (initial?: State) =>
	Layer.effect(
		StateStore,
		Effect.gen(function* () {
			const ref = yield* Ref.make<Versioned>({ state: initial, version: initial ? 1 : 0 })
			return {
				load: Ref.get(ref),
				save: (state: State, expectedVersion: number) =>
					Effect.flatMap(Ref.get(ref), (current) =>
						current.version === expectedVersion
							? Ref.set(ref, { state, version: expectedVersion + 1 })
							: Effect.fail(new Conflict()),
					),
			}
		}),
	)
