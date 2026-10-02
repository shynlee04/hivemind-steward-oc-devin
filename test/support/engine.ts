import { DevinAcp, type DevinAcpEvents } from "../../src/acp"

export const FAKE_BIN = new URL("../fake-acp.ts", import.meta.url).pathname

export interface FakeEngineOptions {
  readonly scenario?: string
  readonly env?: Record<string, string>
  readonly requestTimeoutMs?: number
}

export const fakeEngineSpawn =
  (options: FakeEngineOptions = {}) =>
  (input: { cwd: string; events: DevinAcpEvents }) =>
    DevinAcp.spawn({
      argv: [FAKE_BIN, "acp"],
      cwd: input.cwd,
      autoApprove: false,
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      env: {
        FAKE_ACP_SCENARIO: options.scenario ?? "basic",
        FAKE_ACP_LOG: options.env?.FAKE_ACP_LOG ?? "",
        ...(options.env ?? {}),
      },
      events: input.events,
    })
