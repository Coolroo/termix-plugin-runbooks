/** The rows the store reads and writes, as the rest of the server uses them. */

import type { Capture, Values } from "../../values/values.js";
import type { Check } from "../../checks/checks.js";
import type { StoredStdin } from "../../running/stdin.js";
import type { AskSpec, GenerateSpec } from "../../../shared/secret-steps.js";
import type { StoredRule } from "../../conditions/conditions.js";
import type { DecisionSpec } from "../../../shared/decisions.js";
import type { VmSpec } from "../../../shared/vms.js";
import type {
  RunAttempt,
  RunItem,
  SequenceItem,
} from "../../../shared/sequence.js";
import type {
  AmendKind,
  RunbookOwner,
  RunbookStatus,
  RunIn,
  RunRecord,
  StepOwner,
  StepStatus,
  TokenInfo,
} from "../../../shared/api.js";

// The API's names for what the store keeps (src/shared/api.ts).
export type {
  AmendKind,
  RunbookOwner,
  RunbookStatus,
  RunIn,
  RunSecrets,
  RunStatus,
  StepOwner,
  StepStatus,
  TokenHost,
  TokenHostVm,
} from "../../../shared/api.js";

/** What makes a step an amendment (1.4.0). */
export interface Amendment {
  suffix: string;
  amendsStepId: number;
  amendKind: AmendKind;
  amendReason: string;
  amendedBy: string;
}

export interface RunbookRow {
  id: number;
  title: string;
  summary: string;
  status: RunbookStatus;
  values: Values;
  createdBy: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  /** When a run last stored a captured secret (1.2.0). */
  secretsStoredAt: string | null;
  /** When the runbook's secrets were last deleted (1.2.0). */
  secretsRemovedAt: string | null;
  /** Who the runbook belongs to (1.4.0); null: nobody said. */
  owner: RunbookOwner | null;
  /** Event types the agent wants delivered (1.4.0); null: the default. */
  notify: string[] | null;
}

/** Something that happened to a runbook (1.4.0). */
export interface EventRow {
  id: number;
  runbookId: number;
  stepId: number | null;
  ownerUserId: string;
  type: string;
  reason: string | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  deliveredAt: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
}

export interface StepRow {
  id: number;
  runbookId: number;
  position: number;
  title: string;
  body: string;
  hostId: number | null;
  command: string | null;
  expect: string;
  captures: Capture[];
  hideOutputFromAgents: boolean;
  checks: Check[];
  waitAfterPreviousSeconds: number | null;
  waitReason: string | null;
  /** When the step last ended (run finished or skipped); null while pending. */
  endedAt: string | null;
  /** Where a Run takes standard input from (1.2.0); null for none. */
  stdin: StoredStdin | null;
  /** Secrets a run takes from its output (1.2.0). */
  secretCaptures: Capture[];
  /** Who does the step (1.4.0): a person runs it, an agent completes it. */
  owner: StepOwner;
  /** 1.4.0: where a person runs the command outside Termix; null if not. */
  where: string | null;
  /** 1.4.2: a Make a secret step; null if not. */
  generate: GenerateSpec | null;
  /** 1.4.2: an Ask for a secret step; null if not. */
  ask: AskSpec | null;
  /** 1.4.6: Run, Send to terminal, or both. */
  runIn: RunIn;
  /** 1.4.6: why, in one line; null when not given. */
  runInReason: string | null;
  /** 1.4.6: when the step is needed, steps by id; null: always. */
  when: StoredRule | null;
  /** 1.4.6: a Decision step's options; null if not. */
  decision: DecisionSpec | null;
  /** 1.4.6: Run opens a terminal (pty) for the command. */
  interactive: boolean;
  /** 1.4.7: a VM step's action through HAW; null if not. */
  vm: VmSpec | null;
  /** 1.4.10: the items one Run runs in order; null for a one-command step. */
  sequence: SequenceItem[] | null;
  /** 1.4.10: the folder the command, or each run item, starts in. */
  workdir: string | null;
  /** 1.4.0: the letter of an amendment (3a); null for a step that is not one. */
  suffix: string | null;
  /** 1.4.0: the step this one amends, how, why and by which token. */
  amendsStepId: number | null;
  amendKind: AmendKind | null;
  amendReason: string | null;
  amendedBy: string | null;
  status: StepStatus;
  skipReason: string | null;
  ownerNote: string;
  timeoutMs: number | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** A run as stored: the routes that end a run send it as it is. */
export type RunRow = RunRecord;

/** An agent token as stored: what GET /tokens shows, and its hash. */
export interface TokenRow extends TokenInfo {
  tokenHash: string;
}

export interface NewStep {
  title: string;
  body: string;
  hostId: number | null;
  command: string | null;
  expect: string;
  captures: Capture[];
  hideOutputFromAgents: boolean;
  timeoutMs: number | null;
  checks: Check[];
  waitAfterPreviousSeconds: number | null;
  waitReason: string | null;
  stdin: StoredStdin | null;
  secretCaptures: Capture[];
  owner: StepOwner;
  where: string | null;
  /** 1.4.2: Make a secret; null or left out for any other step. */
  generate?: GenerateSpec | null;
  /** 1.4.2: Ask for a secret; null or left out for any other step. */
  ask?: AskSpec | null;
  /** 1.4.6: left out: either. */
  runIn?: RunIn;
  /** 1.4.6: left out: none. */
  runInReason?: string | null;
  /** 1.4.6: the when rule, steps by id; left out: none. */
  when?: StoredRule | null;
  /** 1.4.6: a Decision step; null or left out for any other step. */
  decision?: DecisionSpec | null;
  /** 1.4.6: left out: false. */
  interactive?: boolean;
  /** 1.4.7: a VM step; null or left out for any other step. */
  vm?: VmSpec | null;
  /** 1.4.10: a sequence step's items; null or left out for any other. */
  sequence?: SequenceItem[] | null;
  /** 1.4.10: left out: none. */
  workdir?: string | null;
}

/** A run item as stored (1.4.10), without its attempts. */
export type RunItemRow = Omit<RunItem, "attempts"> & {
  stepId: number;
  runbookId: number;
};

/** An attempt as stored (1.4.10, phase 2). */
export type RunAttemptRow = RunAttempt & { runId: number; runbookId: number };
