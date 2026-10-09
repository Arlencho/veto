import { Connection, Transaction, type Finality, type Keypair, type TransactionSignature } from "@solana/web3.js";
import { logError } from "./log.js";
import { redactRpcUrlsInText, sleep } from "./rpc.js";

const POLL_MS = 1_000;

function meetsCommitment(status: string | null | undefined, commitment: Finality): boolean {
  if (status === "finalized") return true;
  if (commitment === "finalized") return false;
  return status === "confirmed";
}

function leftoverLine(signature: string, err: unknown): string {
  // The poll error can carry the RPC URL, and providers put the key in its path.
  const message = redactRpcUrlsInText(err instanceof Error ? err.message : String(err));
  return `confirm: leftover status poll after ${signature} was already confirmed: ${message}`;
}

export async function confirmSignature(
  connection: Connection,
  signature: string,
  opts: {
    commitment?: Finality;
    graceMs?: number;
    log?: (line: string) => void;
    /** Give up after this long: polling stops, the listener is removed, and the call rejects. */
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const commitment = opts.commitment ?? "confirmed";
  const graceMs = opts.graceMs ?? 2_000;
  const log = opts.log ?? logError;

  let answered = false;
  let stopped = false;
  let leftover: unknown = null;
  let leftoverLogged = false;
  let subId: number | undefined;

  const markAnswered = (): void => {
    answered = true;
  };

  const logLeftover = (err: unknown): void => {
    leftover = leftover ?? err;
    if (leftoverLogged) return;
    leftoverLogged = true;
    log(leftoverLine(signature, err));
  };

  const ws = new Promise<void>((resolve, reject) => {
    subId = connection.onSignature(
      signature,
      (result) => {
        markAnswered();
        if (result.err) {
          reject(new Error(`transaction ${signature} failed: ${JSON.stringify(result.err)}`));
          return;
        }
        resolve();
      },
      commitment,
    );
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline: Promise<never>[] = [];
  if (opts.timeoutMs !== undefined) {
    const timeoutMs = opts.timeoutMs;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        stopped = true;
        reject(new Error(`transaction ${signature} not confirmed within ${timeoutMs}ms; it may still land`));
      }, timeoutMs);
    });
    void expired.catch(() => {});
    deadline.push(expired);
  }

  const poll = (async () => {
    while (!stopped) {
      if (answered) return;
      try {
        const { value } = await connection.getSignatureStatus(signature);
        if (stopped || answered) return;
        if (value?.err) {
          throw new Error(`transaction ${signature} failed: ${JSON.stringify(value.err)}`);
        }
        if (meetsCommitment(value?.confirmationStatus, commitment)) {
          markAnswered();
          return;
        }
      } catch (err) {
        leftover = err;
        if (stopped || answered) {
          logLeftover(err);
          return;
        }
        throw err;
      }
      if (stopped || answered) return;
      await sleep(POLL_MS);
    }
  })();

  void poll.catch((err) => {
    leftover = leftover ?? err;
    if (answered || stopped) logLeftover(err);
  });

  try {
    const winner = await Promise.race([
      ws.then(() => "ws" as const),
      poll.then(() => "poll" as const).catch((err) => {
        leftover = leftover ?? err;
        return "refused" as const;
      }),
      ...deadline,
    ]);

    if (winner === "ws" || winner === "poll") {
      if (leftover !== null) logLeftover(leftover);
      return;
    }

    // The endpoint refused to answer. Wait for the websocket during the
    // grace; if it confirms, the refuse is leftover. If it does not, throw
    // the refusal that actually happened. A poll that answered not yet never
    // reaches here: it keeps waiting.
    try {
      await Promise.race([
        ws,
        ...deadline,
        sleep(graceMs).then(() => {
          throw leftover instanceof Error ? leftover : new Error(String(leftover ?? "confirm status poll failed"));
        }),
      ]);
      if (leftover !== null) logLeftover(leftover);
    } catch (err) {
      if (answered) {
        logLeftover(err);
        return;
      }
      throw err;
    }
  } finally {
    stopped = true;
    clearTimeout(timer);
    if (subId !== undefined) {
      await connection.removeSignatureListener(subId);
    }
  }
}

export async function sendAndConfirm(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  opts?: { commitment?: Finality; log?: (line: string) => void; timeoutMs?: number },
): Promise<TransactionSignature> {
  const commitment = opts?.commitment ?? "confirmed";
  const signature = await connection.sendTransaction(tx, signers, {
    skipPreflight: false,
    preflightCommitment: commitment,
  });
  await confirmSignature(connection, signature, {
    commitment,
    log: opts?.log,
    timeoutMs: opts?.timeoutMs,
  });
  return signature;
}
