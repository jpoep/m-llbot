import { Option } from "effect"

/**
 * Everything an inline button can trigger. Encoded compactly because Telegram limits
 * callback data to 64 bytes.
 */
export type CallbackAction =
	| { readonly _tag: "Done"; readonly taskId: string; readonly index: number }
	| { readonly _tag: "TakeOver"; readonly taskId: string; readonly index: number }
	| { readonly _tag: "Joker"; readonly taskId: string; readonly index: number }
	| { readonly _tag: "VacationApprove"; readonly vacationId: string }
	| { readonly _tag: "VacationReject"; readonly vacationId: string }
	| { readonly _tag: "VacationCancel"; readonly vacationId: string }
	| { readonly _tag: "AnnoyancePick"; readonly taskId: string }
	| { readonly _tag: "AnnoyancePreview"; readonly taskId: string; readonly level: number }
	| { readonly _tag: "AnnoyanceSave"; readonly taskId: string; readonly level: number }
	| { readonly _tag: "DeleteAsk"; readonly taskId: string }
	| { readonly _tag: "DeleteConfirm"; readonly taskId: string }
	| { readonly _tag: "Dismiss" }

type Tag = CallbackAction["_tag"]

const PREFIX: Record<Tag, string> = {
	Done: "d",
	TakeOver: "t",
	Joker: "j",
	VacationApprove: "va",
	VacationReject: "vr",
	VacationCancel: "vc",
	AnnoyancePick: "np",
	AnnoyancePreview: "nv",
	AnnoyanceSave: "ns",
	DeleteAsk: "xa",
	DeleteConfirm: "xc",
	Dismiss: "x",
}

const TAG_BY_PREFIX = new Map(Object.entries(PREFIX).map(([tag, prefix]) => [prefix, tag as Tag]))

export const encodeCallback = (action: CallbackAction): string => {
	const prefix = PREFIX[action._tag]
	switch (action._tag) {
		case "Done":
		case "TakeOver":
		case "Joker":
			return `${prefix}:${action.taskId}:${action.index}`
		case "VacationApprove":
		case "VacationReject":
		case "VacationCancel":
			return `${prefix}:${action.vacationId}`
		case "AnnoyancePick":
		case "DeleteAsk":
		case "DeleteConfirm":
			return `${prefix}:${action.taskId}`
		case "AnnoyancePreview":
		case "AnnoyanceSave":
			return `${prefix}:${action.taskId}:${action.level}`
		case "Dismiss":
			return prefix
	}
}

const ID = /^[a-z]\d+$/
const parseIndex = (value: string | undefined): Option.Option<number> =>
	value !== undefined && /^\d+$/.test(value) ? Option.some(Number(value)) : Option.none()
const parseId = (value: string | undefined): Option.Option<string> =>
	value !== undefined && ID.test(value) ? Option.some(value) : Option.none()

export const decodeCallback = (data: string): Option.Option<CallbackAction> => {
	const [prefix = "", first, second, ...rest] = data.split(":")
	const tag = TAG_BY_PREFIX.get(prefix)
	if (tag === undefined || rest.length > 0) {
		return Option.none()
	}
	switch (tag) {
		case "Done":
		case "TakeOver":
		case "Joker":
			return Option.all({ taskId: parseId(first), index: parseIndex(second) }).pipe(
				Option.map(({ taskId, index }) => ({ _tag: tag, taskId, index })),
			)
		case "VacationApprove":
		case "VacationReject":
		case "VacationCancel":
			return second === undefined
				? Option.map(parseId(first), (vacationId) => ({ _tag: tag, vacationId }))
				: Option.none()
		case "AnnoyancePick":
		case "DeleteAsk":
		case "DeleteConfirm":
			return second === undefined
				? Option.map(parseId(first), (taskId) => ({ _tag: tag, taskId }))
				: Option.none()
		case "AnnoyancePreview":
		case "AnnoyanceSave":
			return Option.all({ taskId: parseId(first), level: parseIndex(second) }).pipe(
				Option.filter(({ level }) => level <= 10),
				Option.map(({ taskId, level }) => ({ _tag: tag, taskId, level })),
			)
		case "Dismiss":
			return first === undefined ? Option.some({ _tag: tag }) : Option.none()
	}
}
