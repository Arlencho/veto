import { tokenName, tokenSymbol, VTEST_MINT } from './tokens';
import { clusterNotice, loadSession, type WalletStore } from './wallet';

/** Same shape as `veto.notify.asked`: a `'1'` flag in the secure store. */
export const ONBOARDING_SEEN_KEY = 'veto.onboarding.seen';

export type OnboardingCard = {
  title: string;
  body: string;
};

export type LearnStep = OnboardingCard & {
  /** Short name announced with the step, such as "One rule". */
  name: string;
  kicker: string;
  bullets: readonly string[];
  next: string | null;
  lit: readonly ('you' | 'agent' | 'rule' | 'paidOrRefused' | 'blockchain' | 'phone')[];
  caption: string;
  diagramLabel: string;
};

export const LEARN_STEPS: readonly LearnStep[] = [
  {
    name: 'Your agent can only ask',
    kicker: 'How Veto works, 1 of 4',
    title: 'Your agent can only ask.',
    body: 'Your agent never holds your money. You approve one rule on this phone. Veto checks every payment it asks for, and anything outside the rule is refused before money moves.',
    bullets: [
      'Your key stays on this phone, in Seed Vault',
      'Every payment and refusal is saved on the blockchain',
    ],
    next: 'Next: you set one rule',
    lit: ['you', 'agent'],
    caption: 'Your agent can ask. It cannot take.',
    diagramLabel:
      'The Veto machine. In this step, you and your agent are lit: your agent can send a request, and only a request.',
  },
  {
    name: 'One rule',
    kicker: 'How Veto works, 2 of 4',
    title: 'You set one rule.',
    body: 'You choose who your agent may pay, the most per payment, the total it may ever spend, and when the rule ends. The Veto program on Solana enforces it; your agent cannot change it.',
    bullets: [],
    next: 'Next: a refusal is saved',
    lit: ['you', 'rule'],
    caption: 'Your rule goes from you to the gate',
    diagramLabel:
      'The Veto machine. In this step, you and the rule are lit: your rule travels from you to the gate.',
  },
  {
    name: 'A refusal is saved',
    kicker: 'How Veto works, 3 of 4',
    title: 'Ask too much, get nothing.',
    body: 'If your agent asks for more than your rule allows, the Veto program refuses. Nothing moves, and the reason is saved on the blockchain.',
    bullets: [],
    next: 'Next: you decide',
    lit: ['agent', 'rule', 'paidOrRefused', 'blockchain'],
    caption: 'Tilt: the rule said no',
    diagramLabel:
      'The Veto machine. In this step your agent sends a payment the rule does not allow. The gate stops it, the refused lamp lights, and a record with the reason is saved on the blockchain. Nothing is paid.',
  },
  {
    name: 'You decide',
    kicker: 'How Veto works, 4 of 4',
    title: 'You decide.',
    body: 'Your phone tells you. You can let that one payment through or stop the rule, and anyone can check the record on the blockchain.',
    bullets: [],
    next: null,
    lit: ['you', 'blockchain', 'phone'],
    caption: 'The choice comes back to you',
    diagramLabel:
      'The Veto machine. In this step the saved record reaches your phone, which buzzes, and a dotted line leads back up to you: you decide what happens next.',
  },
];

export const ONBOARDING_CARDS: readonly OnboardingCard[] = LEARN_STEPS.map((step) => ({
  title: step.title,
  body: step.body,
}));

/** Routes for the five-stage first run. Help keeps How Veto works on `/onboarding`. */
export const FIRST_RUN_ROUTES = {
  learn: '/first-run',
  how: '/onboarding',
  connect: '/first-run/connect',
  connected: '/first-run/connected',
  agent: '/first-run/agent',
  name: '/first-run/name',
  approve: '/first-run/approve',
  live: '/first-run/live',
  setup: '/first-run/setup',
  alerts: '/first-run/alerts',
  protect: '/first-run/protect',
  finish: '/first-run/finish',
} as const;

export function networkPillLabel(cluster: string | null | undefined, mint?: string | null): string | null {
  if (!cluster) {
    return null;
  }
  if (mint?.trim() === VTEST_MINT && (cluster === 'devnet' || cluster === 'testnet')) {
    return 'Test tokens';
  }
  if (mint?.trim()) {
    return tokenName(mint) ?? tokenSymbol(mint);
  }
  return cluster === 'devnet' ? 'Devnet' : cluster === 'testnet' ? 'Testnet' : cluster === 'mainnet-beta' ? 'Mainnet' : cluster;
}

export const CONNECT_WALLET_BODY =
  'You will approve with your Seeker ID (Seed Vault), the secure key store on this phone. Every rule you approve is signed there. Veto never sees your key.';

export function connectNetworkLine(cluster: string | null | undefined, mint?: string | null): string | null {
  if (!cluster) {
    return null;
  }
  if (cluster === 'devnet' || cluster === 'testnet') {
    const token = mint?.trim() ? ` with ${networkPillLabel(cluster, mint)}` : '';
    return `Test money only. Veto runs on Solana ${cluster}${token}. Your wallet must be set to ${cluster} before you connect.`;
  }
  return clusterNotice(cluster);
}

export const SEED_VAULT_LINE =
  'The owner key stays in Seed Vault. This app never sees it.';

export const OPEN_FIRST_RULE_LABEL = 'Open your first rule';

export const OPEN_FIRST_RULE_NEXT =
  'You set the payee, the largest single payment, a total cap, and an expiry, then sign with the key in Seed Vault.';

export async function loadOnboardingSeen(store: WalletStore): Promise<boolean> {
  const raw = await store.getItem(ONBOARDING_SEEN_KEY);
  return raw === '1';
}

export async function markOnboardingSeen(store: WalletStore): Promise<void> {
  await store.setItem(ONBOARDING_SEEN_KEY, '1');
}

/**
 * The stored flag, or an owner restored from the session store.
 * A fresh install has no session and is not marked seen.
 */
export async function resolveOnboardingSeen(store: WalletStore): Promise<boolean> {
  if (await loadOnboardingSeen(store)) {
    return true;
  }
  const session = await loadSession(store);
  if (!session) {
    return false;
  }
  try {
    await markOnboardingSeen(store);
  } catch {
    // Count this session as seen even when the flag cannot be stored.
  }
  return true;
}

/** First run, before Connect. Seen covers the flag and a restored owner. Help opens the cards on its own route. */
export function showsIntroduction(args: { connected: boolean; seen: boolean }): boolean {
  return !args.connected && !args.seen;
}
