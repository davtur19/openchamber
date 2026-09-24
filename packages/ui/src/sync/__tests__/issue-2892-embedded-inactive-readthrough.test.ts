import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@/lib/opencode/model"
import { INITIAL_STATE, type State } from "../types"
import { readInactiveSessionMessageRecords } from "../sync-context"

function message(id: string, sessionID = "ses_1"): Message {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 1 },
    agent: "build",
    providerID: "anthropic",
    modelID: "claude-sonnet-5",
  }
}

function part(id: string, messageID: string, text = id): Part {
  return { id, messageID, sessionID: "ses_1", type: "text", text }
}

// Shallow copy with fresh buckets: tests mutate only these, and sharing
// INITIAL_STATE's nested objects would leak state across tests.
const baseState = (): State => ({
  ...INITIAL_STATE,
  session: [],
  session_status: {},
  message: {},
  part: {},
})

describe("readInactiveSessionMessageRecords (embedded chat read-through)", () => {
  test("returns null when the session is not renderable yet", () => {
    expect(readInactiveSessionMessageRecords(baseState(), "ses_1")).toBeNull()
  })

  test("returns null when the session has no fetched messages", () => {
    const state = baseState()
    // SAFETY: the renderability check reads only the message buckets, never
    // the session record's other required fields.
    state.session = [{ id: "ses_1", time: { created: 1 } } as SessionLike]
    expect(readInactiveSessionMessageRecords(state, "ses_1")).toBeNull()
  })

  test("returns the materialized history for a renderable session", () => {
    const state = baseState()
    state.message.ses_1 = [message("msg_1"), message("msg_2")]
    state.part.msg_1 = [part("prt_1", "msg_1")]
    state.part.msg_2 = [part("prt_2", "msg_2")]

    const snapshot = readInactiveSessionMessageRecords(state, "ses_1")
    expect(snapshot).not.toBeNull()
    expect(snapshot?.list.map((record) => record.info.id)).toEqual(["msg_1", "msg_2"])
    expect(snapshot?.byId.get("msg_1")?.parts.map((item) => item.id)).toEqual(["prt_1"])
  })

  test("returns null while assistant parts are still missing", () => {
    const state = baseState()
    state.message.ses_1 = [message("msg_1")]
    // No part bucket for the assistant message — not renderable yet.
    expect(readInactiveSessionMessageRecords(state, "ses_1")).toBeNull()
  })

  test("reuses the previous snapshot when state is unchanged", () => {
    const state = baseState()
    state.message.ses_1 = [message("msg_1")]
    state.part.msg_1 = [part("prt_1", "msg_1")]

    const first = readInactiveSessionMessageRecords(state, "ses_1")
    expect(first).not.toBeNull()
    const second = readInactiveSessionMessageRecords(state, "ses_1", first ?? undefined)
    expect(second).toBe(first)
  })
})

type SessionLike = State["session"][number]
