import { redactRpc } from '../../lib/rpcPrivacy';
import { PublicKey } from '@solana/web3.js';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AddressActions } from '../../components/AddressActions';
import { ApprovalScreen } from '../../components/ApprovalScreen';
import { RuleKindSwitch } from '../../components/RuleKindSwitch';
import { TradeRuleForm } from '../../components/TradeRuleForm';
import { HoldToApprove } from '../../components/backglass/HoldToApprove';
import { ClusterPill } from '../../components/daily/ClusterPill';
import { ProgressStrip } from '../../components/backglass/ProgressStrip';
import { Button } from '../../components/Button';
import { ConnectGate } from '../../components/ConnectGate';
import { SpendBoard } from '../../components/daily/SpendBoard';
import { StepPair } from '../../components/daily/StepPair';
import { barUnits, wholePayments } from '../../components/daily/facts';
import { EmptyState } from '../../components/EmptyState';
import { GetDevnetUsdc } from '../../components/GetDevnetUsdc';
import { Field } from '../../components/Field';
import { RuleScreen } from '../../components/RuleScreen';
import { Screen } from '../../components/Screen';
import { TopBar } from '../../components/TopBar';
import { colors, fonts } from '../../components/theme';
import { AGENT_ADDRESS_HINT, parseOptionalAgentAddress } from '../../lib/agentAddress';
import {
  EXPIRY_GUIDANCE,
  LARGEST_PAYMENT_GUIDANCE,
  PAYEE_GUIDANCE,
  TOTAL_CAP_GUIDANCE,
} from '../../lib/ruleGuidance';
import { PURPOSE_MAX_LEN } from '../../lib/constants';
import { askedBaseUnits, isDevnetUsdcMint, showDevnetUsdcFaucet } from '../../lib/faucet';
import { formatBaseUnits, parseBaseUnits } from '../../lib/format';
import { mainnetPreviewNote, devnetTestTokenNote, formatTokenAmount, tokenSymbol } from '../../lib/tokens';
import { useOwnerTokenBalance } from '../../lib/useOwnerTokenBalance';
import type { MandateAccount } from '../../lib/mandate';
import { displayPurpose } from '../../lib/ruleView';
import { renewalChanges, type RenewalChange } from '../../lib/renewal';
import {
  applyRuleset,
  assertPurposeMayOpen,
  PAYEE_NOT_IN_RULESET,
  PAYEE_PREFILL,
  RULESET_ENVELOPE,
  rulesetSlug,
  stampPurpose,
  type Ruleset,
} from '../../lib/ruleset';
import { takeAddressScan } from '../../lib/scanHandoff';
import { applyTemplate, isTradeTemplate, templateById, TEMPLATES, type MandateFields } from '../../lib/templates';
import { useChain } from '../../lib/useChain';
import { useRulesets } from '../../lib/useRulesets';
import { useWallet } from '../../lib/useWallet';

export default function NewRuleScreen() {
  const params = useLocalSearchParams<{
    template?: string;
    ruleset?: string;
    version?: string;
    from?: string;
    renew?: string;
    days?: string;
    cap?: string;
    per?: string;
    payee?: string;
    purpose?: string;
  }>();
  const chain = useChain();
  const stored = useRulesets();
  const sourceMandate = params.from
    ? chain.mandates.find((row) => row.address === params.from)
    : null;
  const selectedRuleset: Ruleset | null = useMemo(() => {
    if (!params.ruleset || params.ruleset === 'new') {
      return null;
    }
    const version = params.version ? Number.parseInt(params.version, 10) : NaN;
    return (
      stored.rulesets.find(
        (row) => row.id === params.ruleset && (Number.isNaN(version) || row.version === version),
      ) ?? null
    );
  }, [params.ruleset, params.version, stored.rulesets]);

  const rulesetMode = Boolean(params.ruleset) || Boolean(params.from);
  if (!rulesetMode) {
    const requested = params.template ?? '';
    const id = templateById(requested) ? requested : 'charging-agent';
    return <NewRuleFlow templateId={id} />;
  }

  const waitingRuleset = Boolean(params.ruleset && params.ruleset !== 'new' && !stored.ready);
  const waitingFrom = Boolean(params.from && chain.mandateStatus === 'not-read');
  if (waitingRuleset || waitingFrom) {
    return (
      <Screen>
        <TopBar
          back="Rules"
          center="New rule"
          accessory={
            chain.config ? <ClusterPill cluster={chain.config.explorerCluster} /> : null
          }
        />
        <EmptyState>Reading this phone and the chain.</EmptyState>
      </Screen>
    );
  }

  const template = params.template ? TEMPLATES.find((row) => row.id === params.template) : undefined;
  const fallback = template ?? templateById('charging-agent');
  const renewing = params.renew === '1' && sourceMandate != null;
  const start: MandateFields = selectedRuleset
    ? {
        cap: selectedRuleset.cap,
        perTxMax: selectedRuleset.perTxMax,
        expiryDays: selectedRuleset.expiryDays,
        merchant: selectedRuleset.merchant,
        purpose: applyRuleset(selectedRuleset).purpose,
      }
    : sourceMandate
      ? {
          cap: renewing && params.cap?.trim() ? params.cap.trim() : formatBaseUnits(sourceMandate.cap, chain.decimals),
          perTxMax:
            renewing && params.per?.trim()
              ? params.per.trim()
              : formatBaseUnits(sourceMandate.perTxMax, chain.decimals),
          expiryDays: renewing && params.days?.trim() ? params.days.trim() : '7',
          merchant:
            renewing && params.payee?.trim() ? params.payee.trim() : sourceMandate.merchant,
          purpose:
            renewing && params.purpose != null && params.purpose.length > 0
              ? params.purpose
              : displayPurpose(sourceMandate.purpose),
        }
      : fallback
        ? applyTemplate(fallback)
        : {
            cap: '80',
            perTxMax: '12',
            expiryDays: '30',
            merchant: '',
            purpose: 'charging agent',
          };

  const formKey = [
    params.template ?? '',
    params.ruleset ?? '',
    params.version ?? '',
    params.from ?? '',
    params.renew ?? '',
    renewing ? (params.days ?? '') : '',
    renewing ? (params.cap ?? '') : '',
    renewing ? (params.per ?? '') : '',
    renewing ? (params.payee ?? '') : '',
    renewing ? (params.purpose ?? '') : '',
  ].join(':');

  return (
    <RuleCompose
      key={formKey}
      initial={start}
      selectedRuleset={selectedRuleset}
      sourceMandate={sourceMandate ?? null}
      authoring={(params.ruleset === 'new' || Boolean(sourceMandate)) && !renewing}
      applying={selectedRuleset != null}
      renewing={renewing}
      initialAgent={renewing ? sourceMandate.agent : ''}
    />
  );
}

function NewRuleFlow({ templateId }: { templateId: string }) {
  const initial = templateById(templateId);
  const [kind, setKind] = useState<'payment' | 'trade'>(isTradeTemplate(initial) ? 'trade' : 'payment');
  const paymentId = initial && !isTradeTemplate(initial) ? templateId : 'charging-agent';
  const tradeId = initial && isTradeTemplate(initial) ? templateId : 'trading-bot';
  const leading = <RuleKindSwitch kind={kind} onChange={setKind} />;
  if (kind === 'trade') {
    return <TradeRuleForm templateId={tradeId} leading={leading} />;
  }
  return (
    <ApprovalScreen
      mode="template"
      request={null}
      invalidReason={null}
      templateId={paymentId}
      leading={leading}
    />
  );
}

function RuleCompose({
  initial,
  selectedRuleset,
  sourceMandate,
  authoring,
  applying,
  renewing,
  initialAgent,
}: {
  initial: MandateFields;
  selectedRuleset: Ruleset | null;
  sourceMandate: MandateAccount | null;
  authoring: boolean;
  applying: boolean;
  renewing: boolean;
  initialAgent: string;
}) {
  const chain = useChain();
  const wallet = useWallet();
  const stored = useRulesets();
  const router = useRouter();
  const [fields, setFields] = useState<MandateFields>(initial);
  const [agentAddress, setAgentAddress] = useState(initialAgent);
  const [rulesetName, setRulesetName] = useState(selectedRuleset?.name ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [openedAddress, setOpenedAddress] = useState<string | null>(null);
  const [holdReset, setHoldReset] = useState(0);
  const openingRef = useRef(false);
  const changed =
    renewing && sourceMandate
      ? renewalChanges(sourceMandate, fields, chain.decimals, BigInt(Math.floor(Date.now() / 1000)))
      : {};
  const formMint = chain.config?.mint ?? null;
  const formSymbol = tokenSymbol(formMint);
  const formCluster = chain.config?.explorerCluster ?? null;
  const tokenNote = mainnetPreviewNote(formMint, formCluster) ?? devnetTestTokenNote(formMint, formCluster);
  const funds = useOwnerTokenBalance(formMint, isDevnetUsdcMint(formCluster, formMint));
  const capNeeded = askedBaseUnits(fields.cap, chain.decimals);
  const showFaucet =
    wallet.ownerPublicKey != null &&
    showDevnetUsdcFaucet({
      cluster: formCluster,
      mint: formMint,
      shortfall: {
        balance: funds.balance,
        needed: capNeeded ?? 0n,
        balanceKnown: funds.known,
      },
    });

  const setField = useCallback((key: keyof MandateFields, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  }, []);

  const stepAmount = (key: 'cap' | 'perTxMax', delta: number) => {
    const unit = 10n ** BigInt(Math.max(0, chain.decimals));
    try {
      const value = parseBaseUnits(fields[key].trim() || '0', chain.decimals);
      const next = value + BigInt(delta) * unit;
      setField(key, formatBaseUnits(next < 0n ? 0n : next, chain.decimals));
    } catch {
      setField(key, delta > 0 ? '1' : '0');
    }
  };

  const stepDays = (delta: number) => {
    const days = Number.parseInt(fields.expiryDays.trim(), 10);
    const base = Number.isFinite(days) ? days : 0;
    setField('expiryDays', String(Math.max(1, base + delta)));
  };

  let board: { payments: string; per: string; cap: string; bars: { remaining: number; cap: number } } | null =
    null;
  try {
    const cap = parseBaseUnits(fields.cap, chain.decimals);
    const per = parseBaseUnits(fields.perTxMax, chain.decimals);
    const count = wholePayments(cap, per);
    if (count != null && per > 0n) {
      board = {
        payments: count.toString(),
        per: formatTokenAmount(per, chain.decimals, formMint),
        cap: formatTokenAmount(cap, chain.decimals, formMint),
        bars: barUnits(cap, cap),
      };
    }
  } catch {
    board = null;
  }

  useFocusEffect(
    useCallback(() => {
      const agent = takeAddressScan('agent');
      if (agent) {
        setAgentAddress(agent);
      }
      const payee = takeAddressScan('payee');
      if (payee) {
        setField('merchant', payee);
      }
    }, [setField]),
  );

  const openFromFields = async (purpose: string) => {
    if (!chain.config) {
      throw new Error(chain.configError ?? 'Config is missing');
    }
    const cap = parseBaseUnits(fields.cap, chain.decimals);
    const perTxMax = parseBaseUnits(fields.perTxMax, chain.decimals);
    const days = Number.parseInt(fields.expiryDays.trim(), 10);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error('expiry must be a whole number of days from now');
    }
    if (purpose.trim().length === 0) {
      throw new Error('purpose is required');
    }
    if (purpose.trim().length > PURPOSE_MAX_LEN) {
      throw new Error(`purpose is longer than ${PURPOSE_MAX_LEN} characters`);
    }
    assertPurposeMayOpen(purpose, applying);
    const merchant = new PublicKey(fields.merchant.trim());
    const agent = parseOptionalAgentAddress({
      text: agentAddress,
      owner: wallet.ownerPublicKey,
      payee: merchant,
    });
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + days * 86400);
    return chain.open({
      merchant,
      cap,
      perTxMax,
      expiresAt,
      purpose: purpose.trim(),
      ...(agent ? { agent } : {}),
    });
  };

  const onOpen = async () => {
    if (openingRef.current || openedAddress || chain.submitHeld) {
      setHoldReset((value) => value + 1);
      return;
    }
    openingRef.current = true;
    setFormError(null);
    setMessage(null);
    try {
      const purpose =
        applying && selectedRuleset ? applyRuleset(selectedRuleset).purpose : fields.purpose;
      const result = await openFromFields(purpose);
      setOpenedAddress(result.mandate.address);
      setMessage(`Opened on chain. Rule ${result.mandate.address}.`);
      router.replace(`/rule/${result.mandate.address}`);
    } catch (err) {
      setHoldReset((value) => value + 1);
      setFormError(err instanceof Error ? redactRpc(err.message) : 'Open failed');
    } finally {
      openingRef.current = false;
    }
  };

  const onSaveRuleset = async () => {
    setFormError(null);
    setMessage(null);
    try {
      const name = rulesetName.trim();
      if (name.length === 0) {
        throw new Error('ruleset name is required');
      }
      const id = rulesetSlug(name);
      const saved = await stored.save({
        id,
        name,
        cap: fields.cap,
        perTxMax: fields.perTxMax,
        expiryDays: fields.expiryDays,
        merchant: fields.merchant,
        purpose: displayPurpose(fields.purpose),
      });
      const stamped = stampPurpose(displayPurpose(fields.purpose), saved.id, saved.version);
      setMessage(
        `Saved ${saved.name} v${saved.version} on this phone. The ruleset itself is not on chain. Apply it to a new agent to stamp "${stamped}" into the purpose.`,
      );
    } catch (err) {
      setFormError(err instanceof Error ? redactRpc(err.message) : 'Save failed');
    }
  };

  const title = renewing
    ? 'The next rule'
    : applying && selectedRuleset
      ? `Apply ${selectedRuleset.name} v${selectedRuleset.version}`
      : authoring
        ? 'Author a ruleset'
        : 'Write a rule';

  const connected = wallet.ownerPublicKey !== null;
  const footer = connected ? (
    <View style={styles.actions}>
      {formError ? <Text style={styles.msg}>{formError}</Text> : null}
      {message ? <Text style={styles.msg}>{message}</Text> : null}
      {openedAddress ? null : applying ? (
        <HoldToApprove
          label="Press and hold to apply to a new agent"
          hint="Signed inside Seed Vault. Veto never sees your key."
          disabled={chain.submitHeld || wallet.busy}
          resetKey={holdReset}
          onConfirm={() => {
            void onOpen();
          }}
        />
      ) : (
        <>
          {authoring ? (
            <Button
              label="Save ruleset on this phone"
              invert={false}
              onPress={() => {
                void onSaveRuleset();
              }}
            />
          ) : null}
          <HoldToApprove
            label="Press and hold to approve rule"
            hint="Signed inside Seed Vault. Veto never sees your key."
            disabled={chain.submitHeld || wallet.busy}
            resetKey={holdReset}
            onConfirm={() => {
              void onOpen();
            }}
          />
        </>
      )}
    </View>
  ) : null;

  return (
    <RuleScreen footer={footer}>
      <TopBar
        back="Rules"
        center="New rule"
        accessory={chain.config ? <ClusterPill cluster={chain.config.explorerCluster} /> : null}
      />
      <ConnectGate>
        {!authoring && !applying && !renewing ? (
          <ProgressStrip current="approve" done={['learn', 'connect', 'agent']} />
        ) : null}
        {!authoring && !applying && !renewing ? (
          <View style={styles.kickerRow}>
            <Text style={styles.kicker}>Write the rule yourself</Text>
            <Text style={styles.meta}>No agent request yet</Text>
          </View>
        ) : null}
        <Text style={styles.h2}>{title}</Text>
        {renewing ? (
          <EmptyState>
            One Seed Vault signature opens this next rule. The rule that is ending stays as it is
            until it ends. Nothing is signed until you hold to approve.
          </EmptyState>
        ) : sourceMandate ? (
          <EmptyState>
            {`This rule is already on chain and cannot change. Saving writes a new ruleset version on this phone. Apply it to a new agent. The existing agent keeps these numbers. ${RULESET_ENVELOPE} ${PAYEE_NOT_IN_RULESET} ${PAYEE_PREFILL}`}
          </EmptyState>
        ) : applying && selectedRuleset ? (
          <EmptyState>
            {`One action opens a new rule for a new agent, with ${selectedRuleset.name} v${selectedRuleset.version} stamped into the purpose. The ruleset file stays on this phone. ${PAYEE_NOT_IN_RULESET} ${PAYEE_PREFILL}`}
          </EmptyState>
        ) : authoring ? (
          <EmptyState>
            {`${RULESET_ENVELOPE} ${PAYEE_NOT_IN_RULESET} ${PAYEE_PREFILL} Saving writes the ruleset on this phone. The ruleset itself is not on chain.`}
          </EmptyState>
        ) : (
          <EmptyState>
            One Seed Vault signature opens the rule, moves the cap into a token account that belongs
            only to this rule, and delegates that account. Confirmation is read back from chain, not
            from this form.
          </EmptyState>
        )}

        {tokenNote ? <Text style={styles.tokenNote}>{tokenNote}</Text> : null}
        {authoring ? (
          <Field
            label="Ruleset name"
            value={rulesetName}
            onChangeText={setRulesetName}
            placeholder="Mint budget"
          />
        ) : null}
        <View style={styles.dial}>
          <View style={styles.dialField}>
            <Field
              label="Cap"
              accessibilityLabel={formSymbol ? `Cap, ${formSymbol}` : 'Cap'}
              suffix={formSymbol || undefined}
              value={fields.cap}
              onChangeText={(text) => setField('cap', text)}
              placeholder="total, in tokens"
              editable={!applying}
              hint={TOTAL_CAP_GUIDANCE}
            />
          </View>
          <StepPair
            downLabel="Lower total"
            upLabel="Raise total"
            disabled={applying}
            onDown={() => stepAmount('cap', -1)}
            onUp={() => stepAmount('cap', 1)}
          />
        </View>
        <ChangedLine change={changed.cap} />
        {showFaucet && wallet.ownerPublicKey ? <GetDevnetUsdc owner={wallet.ownerPublicKey} /> : null}
        <View style={styles.dial}>
          <View style={styles.dialField}>
            <Field
              label="Per-payment maximum"
              accessibilityLabel={formSymbol ? `Per-payment maximum, ${formSymbol}` : 'Per-payment maximum'}
              suffix={formSymbol || undefined}
              value={fields.perTxMax}
              onChangeText={(text) => setField('perTxMax', text)}
              placeholder="largest single payment"
              editable={!applying}
              hint={LARGEST_PAYMENT_GUIDANCE}
            />
          </View>
          <StepPair
            downLabel="Lower most per payment"
            upLabel="Raise most per payment"
            disabled={applying}
            onDown={() => stepAmount('perTxMax', -1)}
            onUp={() => stepAmount('perTxMax', 1)}
          />
        </View>
        <ChangedLine change={changed.perTxMax} />
        <View style={styles.dial}>
          <View style={styles.dialField}>
            <Field
              label="Expiry (days from now)"
              value={fields.expiryDays}
              onChangeText={(text) => setField('expiryDays', text)}
              placeholder="7"
              editable={!applying}
              hint={EXPIRY_GUIDANCE}
            />
          </View>
          <StepPair
            downLabel="Shorten the rule"
            upLabel="Extend the rule"
            disabled={applying}
            onDown={() => stepDays(-1)}
            onUp={() => stepDays(1)}
          />
        </View>
        <ChangedLine change={changed.expiryDays} />
        <Field
          label="Payee"
          value={fields.merchant}
          onChangeText={(text) => setField('merchant', text)}
          placeholder={
            applying || authoring
              ? 'chosen per agent, prefills so you do not retype an address'
              : 'the only wallet that may be paid'
          }
          hint={PAYEE_GUIDANCE}
        />
        <ChangedLine change={changed.merchant} />
        <AddressActions
          target="payee"
          onAddress={(address) => setField('merchant', address)}
          onInvalid={setFormError}
        />
        <Field
          label="Agent address"
          value={agentAddress}
          onChangeText={setAgentAddress}
          placeholder="optional"
          hint={AGENT_ADDRESS_HINT}
        />
        <AddressActions target="agent" onAddress={setAgentAddress} onInvalid={setFormError} />
        <Field
          label="Purpose"
          value={applying && selectedRuleset ? applyRuleset(selectedRuleset).purpose : fields.purpose}
          onChangeText={(text) => setField('purpose', text)}
          placeholder="in your own words"
          multiline
          editable={!applying}
        />
        <ChangedLine change={changed.purpose} />
        {board ? (
          <SpendBoard
            kicker="Your agent's board"
            remainingText={board.cap}
            ofText="set aside"
            spentText={board.payments}
            spentCaption={`payments of ${board.per} at most`}
            remaining={board.bars.remaining}
            cap={board.bars.cap}
            accessibilityLabel={`${board.payments} payments of ${board.per} at most, ${board.cap} set aside`}
            leftCaption={`1 block = one payment of ${board.per}`}
            rightCaption="Leftover comes back"
          />
        ) : null}
      </ConnectGate>
    </RuleScreen>
  );
}

/** Under a renewal field: what the rule being renewed had, and what this form will sign. */
function ChangedLine({ change }: { change: RenewalChange | undefined }) {
  if (!change) {
    return null;
  }
  return (
    <Text style={styles.changed} accessibilityRole="text" selectable>
      {`Changed from ${change.from} to ${change.to || 'nothing'}`}
    </Text>
  );
}

const styles = StyleSheet.create({
  h2: {
    color: colors.bone,
    fontSize: 32,
    fontFamily: fonts.serif,
  },
  kickerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  kicker: {
    color: colors.muted,
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  tokenNote: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  changed: {
    color: colors.tilt,
    fontFamily: fonts.sansBold,
    fontSize: 13,
    lineHeight: 18,
  },
  meta: {
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
  },
  dial: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  dialField: {
    flex: 1,
  },
  actions: {
    gap: 10,
    alignSelf: 'stretch',
  },
  msg: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
});
