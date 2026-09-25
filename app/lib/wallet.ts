import { Buffer } from 'buffer';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';

import { walletChainForCluster } from './appConfig';

export const APP_IDENTITY = {
  name: 'Veto',
  uri: 'https://veto-hq.github.io',
  icon: '/icon.png',
} as const;

export const SESSION_STORE_KEY = 'veto.wallet.session';
export const AGENT_SECRET_STORE_KEY = 'veto.wallet.agentSecret';
export const AGENTS_STORE_KEY = 'veto.wallet.agents';

export type WalletStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
};

export type MwaAccount = {
  address: string;
  publicKey?: Uint8Array;
};

export type AuthorizeParams = {
  identity: { name: string; uri?: string; icon?: string };
  chain?: string;
  auth_token?: string;
};

export type SignAndSendParams = {
  transactions: Transaction[];
  minContextSlot?: number;
  commitment?: string;
  skipPreflight?: boolean;
  maxRetries?: number;
};

export type MwaWallet = {
  authorize(params: AuthorizeParams): Promise<{
    accounts: readonly MwaAccount[];
    auth_token: string;
    wallet_uri_base?: string;
  }>;
  deauthorize(params: { auth_token: string }): Promise<unknown>;
  signAndSendTransactions?(params: SignAndSendParams): Promise<string[]>;
};

export type AssociationConfig = {
  baseUri?: string;
};

export type TransactFn = <T>(
  callback: (wallet: MwaWallet) => Promise<T>,
  config?: AssociationConfig,
) => Promise<T>;

export type StoredSession = {
  authToken: string;
  ownerPublicKey: string;
  walletUriBase?: string;
};

export type ConnectOptions = {
  baseUri?: string;
  chooser?: boolean;
};

export const SEEKER_APPROVAL_LINE = 'You will approve with your Seeker ID (Seed Vault).';

export const USER_CANCELLED_MESSAGE = 'You cancelled the wallet request.';
export const WALLET_REJECTED_MESSAGE = 'The wallet rejected the request.';
export const SESSION_CLOSED_MESSAGE = 'The wallet closed the session without a signature.';

export function clusterNotice(cluster: string): string {
  return `This app uses ${cluster}. The wallet must be on ${cluster}.`;
}

export function signatureNotOnClusterMessage(cluster: string): string {
  return `The wallet did not submit the transaction. ${clusterNotice(cluster)}`;
}

export function signatureNotYetVisibleMessage(cluster: string): string {
  return `The transaction has not appeared on ${cluster} yet. It may still land, so check your rules before trying again. The wallet must be on ${cluster}.`;
}

export function signatureSeenUnconfirmedMessage(cluster: string): string {
  return `The transaction was seen on ${cluster} but is not confirmed yet. It may still land, so check your rules before trying again.`;
}

export type ConnectedWallet = {
  authToken: string;
  ownerPublicKey: string;
  agentPublicKey: string;
};

export type WalletSnapshot = {
  session: StoredSession | null;
  agentPublicKey: string;
};

export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2) {
    return address;
  }
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/** Short form of the payee wallet named on a rule. */
export function payeeLabel(wallet: string | null | undefined): string {
  const owner = wallet?.trim() ?? '';
  if (!owner) {
    return "the rule's payee";
  }
  return truncateAddress(owner);
}

export function publicKeyFromMwaAddress(address: string): PublicKey {
  // Mobile Wallet Adapter sends the address base64 encoded, but a base58
  // address has to be accepted too, and the two are not safely told apart by
  // length alone. Buffer.from(s, 'base64') never fails: it drops characters
  // outside the alphabet and decodes whatever is left. Every base58 character
  // is also a base64 character, so a 43 character base58 address decodes to
  // exactly 32 bytes of nonsense, and the old 32-byte check accepted it and
  // returned a different wallet with no error at all.
  //
  // A public key encodes to 43 characters when its first byte is zero, so this
  // reached roughly one owner in 256, silently, and every rule and decision
  // would then be read for a wallet nobody holds.
  //
  // The decode is trusted only when re-encoding reproduces the input, which is
  // what makes the guess checkable rather than merely plausible.
  const bytes = Buffer.from(address, 'base64');
  if (bytes.length === 32 && bytes.toString('base64') === address) {
    return new PublicKey(bytes);
  }
  return new PublicKey(address);
}

export function publicKeyFromAccount(account: MwaAccount): PublicKey {
  if (account.publicKey && account.publicKey.length === 32) {
    return new PublicKey(account.publicKey);
  }
  return publicKeyFromMwaAddress(account.address);
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.authToken === 'string' &&
    typeof rec.ownerPublicKey === 'string' &&
    rec.ownerPublicKey.length > 0
  );
}

export async function loadSession(store: WalletStore): Promise<StoredSession | null> {
  const raw = await store.getItem(SESSION_STORE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredSession(parsed)) {
      return null;
    }
    new PublicKey(parsed.ownerPublicKey);
    const walletUriBase = httpsWalletBase(
      (parsed as { walletUriBase?: unknown }).walletUriBase,
    );
    return walletUriBase ? { ...parsed, walletUriBase } : parsed;
  } catch {
    return null;
  }
}

export function httpsWalletBase(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('https://')) {
    return undefined;
  }
  return trimmed;
}

export async function persistSession(
  store: WalletStore,
  session: StoredSession,
): Promise<void> {
  const walletUriBase = httpsWalletBase(session.walletUriBase);
  const payload: StoredSession = {
    authToken: session.authToken,
    ownerPublicKey: session.ownerPublicKey,
    ...(walletUriBase ? { walletUriBase } : {}),
  };
  await store.setItem(SESSION_STORE_KEY, JSON.stringify(payload));
}

export async function clearSession(store: WalletStore): Promise<void> {
  await store.deleteItem(SESSION_STORE_KEY);
}

/**
 * Forgets the auth_token the wallet refused but keeps the owner and wallet,
 * so the app stays connected and the next authorize starts fresh.
 */
export async function clearSessionToken(store: WalletStore): Promise<void> {
  const stored = await loadSession(store);
  if (stored) {
    await persistSession(store, { ...stored, authToken: '' });
  }
}

function readFailed(detail: string): Error {
  return new Error(`could not read the stored agent identity: ${detail}`);
}

function parseAgentSecret(raw: string): Keypair {
  try {
    const secret = Buffer.from(raw, 'base64');
    if (secret.length !== 64) {
      throw new Error(`secret is ${secret.length} bytes, expected 64`);
    }
    return Keypair.fromSecretKey(secret);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw readFailed(detail);
  }
}

function parseAgentsMap(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('agent map is not an object');
    }
    return parsed as Record<string, string>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw readFailed(detail);
  }
}

export async function loadAgentKeypair(store: WalletStore): Promise<Keypair | null> {
  const raw = await store.getItem(AGENT_SECRET_STORE_KEY);
  if (!raw) {
    return null;
  }
  return parseAgentSecret(raw);
}

async function rememberAgent(store: WalletStore, keypair: Keypair): Promise<void> {
  const raw = await store.getItem(AGENTS_STORE_KEY);
  const map = raw ? parseAgentsMap(raw) : {};
  const pk = keypair.publicKey.toBase58();
  if (!map[pk]) {
    map[pk] = Buffer.from(keypair.secretKey).toString('base64');
    await store.setItem(AGENTS_STORE_KEY, JSON.stringify(map));
  }
}

async function persistAgent(store: WalletStore, keypair: Keypair): Promise<void> {
  await store.setItem(
    AGENT_SECRET_STORE_KEY,
    Buffer.from(keypair.secretKey).toString('base64'),
  );
  await rememberAgent(store, keypair);
}

export async function loadOrCreateAgentPublicKey(
  store: WalletStore,
  generate: () => Keypair = Keypair.generate,
): Promise<string> {
  const existing = await loadAgentKeypair(store);
  if (existing) {
    await rememberAgent(store, existing);
    return existing.publicKey.toBase58();
  }
  const created = generate();
  await persistAgent(store, created);
  return created.publicKey.toBase58();
}

export async function createAgentKeypair(
  store: WalletStore,
  generate: () => Keypair = Keypair.generate,
): Promise<Keypair> {
  const created = generate();
  await persistAgent(store, created);
  return created;
}

async function clusterForWallet(): Promise<string> {
  try {
    const { loadConfig } = await import('./config');
    return loadConfig().explorerCluster;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Unknown cluster')) {
      throw err;
    }
    const raw = process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER?.trim() ?? '';
    return raw.length > 0 ? raw : 'devnet';
  }
}

export async function configuredCluster(): Promise<string> {
  return clusterForWallet();
}

function numericCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const record = error as { code?: unknown; userInfo?: { jsonRpcErrorCode?: unknown } };
  if (typeof record.code === 'number') {
    return record.code;
  }
  const nested = record.userInfo?.jsonRpcErrorCode;
  return typeof nested === 'number' ? nested : undefined;
}

export function explainWalletFailure(error: unknown, cluster: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (
    message === USER_CANCELLED_MESSAGE ||
    message === WALLET_REJECTED_MESSAGE ||
    message === SESSION_CLOSED_MESSAGE ||
    message.startsWith('The wallet did not submit the transaction.') ||
    message.startsWith('The transaction has not appeared on ') ||
    message.startsWith('The transaction was seen on ')
  ) {
    return message;
  }
  const code = numericCode(error);
  const lower = message.toLowerCase();
  if (code === -4 || lower.includes('not submitted') || lower.includes('did not submit')) {
    return signatureNotOnClusterMessage(cluster);
  }
  if (lower.includes('cancel')) {
    return USER_CANCELLED_MESSAGE;
  }
  if (code === -1 || code === -3 || lower.includes('reject') || lower.includes('declin')) {
    return WALLET_REJECTED_MESSAGE;
  }
  if (
    lower.includes('session closed') ||
    lower.includes('session was closed') ||
    lower.includes('session dropped') ||
    lower.includes('without a signature') ||
    lower.includes('no signature') ||
    lower.includes('timed out waiting')
  ) {
    return SESSION_CLOSED_MESSAGE;
  }
  if (lower.includes('not found') || lower.includes('no wallet')) {
    return 'No Mobile Wallet Adapter wallet was found';
  }
  if (message.length > 0) {
    return message;
  }
  return 'Wallet request failed';
}

export function associationBaseUri(input: {
  chooser?: boolean;
  storedBaseUri?: string | null;
  directBaseUri?: string | null;
}): string | undefined {
  if (input.chooser) {
    return undefined;
  }
  return httpsWalletBase(input.storedBaseUri) ?? httpsWalletBase(input.directBaseUri);
}

function associationConfig(baseUri: string | undefined): AssociationConfig | undefined {
  return baseUri ? { baseUri } : undefined;
}

export type SignatureStatusName = 'confirmed' | 'missing' | 'failed' | 'seen';

export type SignatureLookup = (signature: string) => Promise<SignatureStatusName>;

type SignatureStatusRow = {
  err: unknown;
  confirmationStatus?: string | null;
} | null;

type SignatureStatusConnection = {
  getSignatureStatuses(
    signatures: string[],
    config?: { searchTransactionHistory: boolean },
  ): Promise<{ value: SignatureStatusRow[] }>;
};

function signatureStatusName(row: SignatureStatusRow): SignatureStatusName {
  if (!row) {
    return 'missing';
  }
  if (row.err) {
    return 'failed';
  }
  if (row.confirmationStatus === 'confirmed' || row.confirmationStatus === 'finalized') {
    return 'confirmed';
  }
  // processed is already on this cluster. It is not the same as absent.
  if (row.confirmationStatus === 'processed') {
    return 'seen';
  }
  return 'missing';
}

async function readSignatureOnConfiguredRpc(
  signature: string,
  connection: SignatureStatusConnection,
): Promise<SignatureStatusName> {
  let row: SignatureStatusRow = null;
  try {
    const status = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    row = status.value[0] ?? null;
  } catch {
    return 'missing';
  }
  return signatureStatusName(row);
}

async function openConfiguredConnection(): Promise<SignatureStatusConnection> {
  const { loadConfig } = await import('./config');
  return new Connection(loadConfig().rpcUrl, 'confirmed');
}

const defaultSignatureLookup: SignatureLookup = async (signature) =>
  readSignatureOnConfiguredRpc(signature, await signatureConfirmation.openConnection());

export const signatureConfirmation = {
  timeoutMs: 20_000,
  pollMs: 750,
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  lookup: defaultSignatureLookup,
  openConnection: openConfiguredConnection,
};

function lookupOverride(options?: { lookup?: SignatureLookup }): SignatureLookup | undefined {
  if (options?.lookup) {
    return options.lookup;
  }
  if (signatureConfirmation.lookup !== defaultSignatureLookup) {
    return signatureConfirmation.lookup;
  }
  return undefined;
}

async function confirmSignatures(
  signatures: string[],
  cluster: string,
  options?: { timeoutMs?: number; lookup?: SignatureLookup },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? signatureConfirmation.timeoutMs;
  const override = lookupOverride(options);
  let lookup: SignatureLookup;
  if (override) {
    lookup = override;
  } else {
    const connection = await signatureConfirmation.openConnection();
    lookup = (signature) => readSignatureOnConfiguredRpc(signature, connection);
  }
  for (const signature of signatures) {
    const started = signatureConfirmation.now();
    let seen = false;
    for (;;) {
      let status: SignatureStatusName = 'missing';
      try {
        status = await lookup(signature);
      } catch {
        status = 'missing';
      }
      if (status === 'confirmed') {
        break;
      }
      if (status === 'failed') {
        throw new Error(`The transaction was found on ${cluster} but it failed.`);
      }
      if (status === 'seen') {
        seen = true;
      }
      if (signatureConfirmation.now() - started >= timeoutMs) {
        throw new Error(
          seen ? signatureSeenUnconfirmedMessage(cluster) : signatureNotYetVisibleMessage(cluster),
        );
      }
      await signatureConfirmation.sleep(signatureConfirmation.pollMs);
    }
  }
}

export type AuthorizeResult = Awaited<ReturnType<MwaWallet['authorize']>>;

/**
 * True when the wallet refused an authorize call that carried an auth_token
 * and the refusal was not the owner declining. A wallet answers a token it no
 * longer honours (after a reinstall, for example) with code -1 and
 * "authorization request failed" within the same moment, before the owner can
 * act, so this is read as a stale token rather than a decision.
 */
export function isStaleAuthTokenError(error: unknown): boolean {
  if (numericCode(error) !== -1) {
    return false;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return !(message.includes('declin') || message.includes('cancel') || message.includes('reject'));
}

/**
 * The one place every authorize call goes through. A stored token the wallet
 * refuses is cleared and a fresh authorize is asked once, in the same wallet
 * session. A decline, or a failure of the fresh authorize, is thrown as is.
 */
export async function authorizeAccounts(
  wallet: MwaWallet,
  storedAuthToken?: string,
  store?: WalletStore,
): Promise<AuthorizeResult> {
  const chain = walletChainForCluster(await clusterForWallet());
  const request = (authToken?: string) =>
    wallet.authorize({
      identity: APP_IDENTITY,
      chain,
      ...(authToken ? { auth_token: authToken } : {}),
    });
  if (!storedAuthToken) {
    return request();
  }
  try {
    return await request(storedAuthToken);
  } catch (err) {
    if (!isStaleAuthTokenError(err)) {
      throw err;
    }
    if (store) {
      await clearSessionToken(store);
    }
    return request();
  }
}

export async function authorize(
  wallet: MwaWallet,
  storedAuthToken?: string,
  store?: WalletStore,
): Promise<StoredSession> {
  const result = await authorizeAccounts(wallet, storedAuthToken, store);
  const account = result.accounts[0];
  if (!account) {
    throw new Error('Wallet authorized no accounts');
  }
  const walletUriBase = httpsWalletBase(result.wallet_uri_base);
  return {
    authToken: result.auth_token,
    ownerPublicKey: publicKeyFromAccount(account).toBase58(),
    ...(walletUriBase ? { walletUriBase } : {}),
  };
}

export async function connect(
  transact: TransactFn,
  store: WalletStore,
  generate: () => Keypair = Keypair.generate,
  options?: ConnectOptions,
): Promise<ConnectedWallet> {
  const stored = await loadSession(store);
  const baseUri = associationBaseUri({
    chooser: options?.chooser,
    storedBaseUri: stored?.walletUriBase,
    directBaseUri: options?.baseUri,
  });
  let session: StoredSession;
  try {
    session = await transact(
      (wallet) => authorize(wallet, options?.chooser ? undefined : stored?.authToken, store),
      associationConfig(baseUri),
    );
  } catch (err) {
    throw new Error(explainWalletFailure(err, await clusterForWallet()));
  }
  await persistSession(store, session);
  const agentPublicKey = await loadOrCreateAgentPublicKey(store, generate);
  return {
    authToken: session.authToken,
    ownerPublicKey: session.ownerPublicKey,
    agentPublicKey,
  };
}

export async function disconnect(transact: TransactFn, store: WalletStore): Promise<void> {
  const stored = await loadSession(store);
  try {
    if (stored?.authToken) {
      await transact(
        (wallet) => wallet.deauthorize({ auth_token: stored.authToken }),
        associationConfig(stored.walletUriBase),
      );
    }
  } finally {
    await clearSession(store);
  }
}

export async function restore(
  store: WalletStore,
  generate: () => Keypair = Keypair.generate,
): Promise<WalletSnapshot> {
  const agentPublicKey = await loadOrCreateAgentPublicKey(store, generate);
  const session = await loadSession(store);
  return { session, agentPublicKey };
}

function signaturesFromWallet(value: unknown, expected: number): string[] {
  if (!Array.isArray(value) || value.length !== expected) {
    throw new Error(SESSION_CLOSED_MESSAGE);
  }
  const signatures = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (signatures.length !== expected) {
    throw new Error(SESSION_CLOSED_MESSAGE);
  }
  return signatures;
}

export async function signAndSendTransactions(
  transact: TransactFn,
  store: WalletStore,
  transactions: Transaction[],
  options?: { timeoutMs?: number; lookup?: SignatureLookup },
): Promise<string[]> {
  if (transactions.length === 0) {
    throw new Error('no transactions to sign');
  }
  const cluster = await clusterForWallet();
  const stored = await loadSession(store);
  try {
    const signatures = await transact(async (wallet) => {
      const session = await authorize(wallet, stored?.authToken, store);
      await persistSession(store, session);
      if (!wallet.signAndSendTransactions) {
        throw new Error('Wallet cannot sign and send transactions');
      }
      const signed = await wallet.signAndSendTransactions({
        transactions,
        commitment: 'confirmed',
      });
      return signaturesFromWallet(signed, transactions.length);
    }, associationConfig(stored?.walletUriBase));
    await confirmSignatures(signatures, cluster, options);
    return signatures;
  } catch (err) {
    throw new Error(explainWalletFailure(err, cluster));
  }
}
