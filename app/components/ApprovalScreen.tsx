import { PublicKey } from '@solana/web3.js';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  addressLine,
  agentFieldReady,
  approvalSentence,
  canApprove,
  capFromRing,
  clampTemplate,
  clampToRequest,
  customDateWithin,
  DURATION_DAYS,
  durationChipAllowed,
  expiryFromDays,
  formatUntilDate,
  fractionFromAmount,
  partyDisplay,
  payeeFieldReady,
  purposeFieldReady,
  templateCapCeiling,
  templateLimits,
} from '../lib/approval';
import { loadAddressBook, saveAddressBook, withSavedName } from '../lib/addressBook';
import { parseOptionalAgentAddress } from '../lib/agentAddress';
import { createClient, type OpenMandateResult } from '../lib/chain';
import { formatBaseUnits } from '../lib/format';
import { showDevnetUsdcFaucet } from '../lib/faucet';
import { devnetTestTokenNote, withToken } from '../lib/tokens';
import { secureStore } from '../lib/mwa';
import { evaluatePresign, type PresignObservation } from '../lib/presign';
import { observePresign } from '../lib/presignRead';
import { canonicalAddress, type RuleRequestV1 } from '../lib/ruleRequest';
import { takeAddressScan, takeWriteRule } from '../lib/scanHandoff';
import { BUILD_YOUR_OWN_IDS, templateById, type MandateTemplate } from '../lib/templates';
import { useChain } from '../lib/useChain';
import { useWallet } from '../lib/useWallet';
import { AddressActions } from './AddressActions';
import { GetDevnetUsdc } from './GetDevnetUsdc';
import { Button } from './Button';
import { BLOCK_COUNT, BlockBar } from './backglass/BlockBar';
import { HoldToApprove } from './backglass/HoldToApprove';
import { ProgressStrip } from './backglass/ProgressStrip';
import { ConnectGate } from './ConnectGate';
import { Field } from './Field';
import { RuleScreen } from './RuleScreen';
import { TopBar } from './TopBar';
import { colors, fonts, radii, space } from './theme';

type DurationChoice = { kind: 'days'; days: number } | { kind: 'date'; iso: string };

export function ApprovalScreen({
  mode,
  request,
  invalidReason,
  templateId,
  initialAgent,
  firstRun = false,
  onOpened,
  onDecline,
}: {
  mode: 'request' | 'template';
  request: RuleRequestV1 | null;
  invalidReason: string | null;
  templateId?: string;
  initialAgent?: string;
  firstRun?: boolean;
  onOpened?: (result: OpenMandateResult) => void;
  onDecline?: () => void;
}) {
  if (invalidReason || (mode === 'request' && !request)) {
    return (
      <RuleScreen>
        <TopBar back="Rules" />
        <Text style={styles.h2}>This request is not valid.</Text>
        <Text style={styles.body}>{invalidReason ?? 'This is not a rule request.'}</Text>
      </RuleScreen>
    );
  }

  return (
    <ApprovalCard
      mode={mode}
      request={request}
      templateId={templateId ?? 'charging-agent'}
      initialAgent={initialAgent}
      firstRun={firstRun}
      onOpened={onOpened}
      onDecline={onDecline}
    />
  );
}

function ApprovalCard({
  mode,
  request,
  templateId,
  initialAgent,
  firstRun,
  onOpened,
  onDecline,
}: {
  mode: 'request' | 'template';
  request: RuleRequestV1 | null;
  templateId: string;
  initialAgent?: string;
  firstRun: boolean;
  onOpened?: (result: OpenMandateResult) => void;
  onDecline?: () => void;
}) {
  const chain = useChain();
  const wallet = useWallet();
  const router = useRouter();
  const initialTemplate = templateById(templateId) ?? templateById('charging-agent');
  const [template, setTemplate] = useState<MandateTemplate | null>(initialTemplate ?? null);
  const [agentText, setAgentText] = useState(request?.agent ?? initialAgent ?? '');
  const [selfWrite, setSelfWrite] = useState(false);
  const [holdReset, setHoldReset] = useState(0);
  const [payeeText, setPayeeText] = useState(request?.payee ?? '');
  const [purpose, setPurpose] = useState(request?.purpose ?? initialTemplate?.fields.purpose ?? '');
  const [capTouched, setCapTouched] = useState<bigint | null>(request ? request.cap : null);
  const [maxTouched, setMaxTouched] = useState<bigint | null>(request ? request.max : null);
  const [choice, setChoice] = useState<DurationChoice>({
    kind: 'days',
    days: request?.days ?? Number(initialTemplate?.fields.expiryDays ?? '7'),
  });
  const [customDate, setCustomDate] = useState('');
  const [dateError, setDateError] = useState<string | null>(null);
  const [openedAt] = useState(() => Date.now());
  const [book, setBook] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState({ agent: false, payee: false });
  const [naming, setNaming] = useState<'agent' | 'payee' | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [observation, setObservation] = useState<{ key: string; value: PresignObservation } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [openedAddress, setOpenedAddress] = useState<string | null>(null);
  const openingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadAddressBook(secureStore).then((loaded) => {
      if (!cancelled) {
        setBook(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (request) {
        return;
      }
      const written = takeWriteRule();
      if (written) {
        setAgentText(written);
        setSelfWrite(true);
      }
      const agent = takeAddressScan('agent');
      if (agent) {
        setAgentText(agent);
      }
      const payee = takeAddressScan('payee');
      if (payee) {
        setPayeeText(payee);
      }
    }, [request]),
  );

  const mintText = request?.mint ?? chain.config?.mint ?? null;
  const payeeCanonical = canonicalAddress(payeeText.trim());
  const agentCanonical = canonicalAddress(agentText.trim());
  const readKey = `${chain.config?.rpcUrl ?? ''}|${wallet.ownerPublicKey ?? ''}|${mintText ?? ''}|${payeeCanonical ?? ''}`;
  const liveObservation = observation?.key === readKey ? observation.value : null;

  useEffect(() => {
    if (!chain.config || !wallet.ownerPublicKey || !mintText) {
      return;
    }
    let mint: PublicKey;
    try {
      mint = new PublicKey(mintText);
    } catch {
      return;
    }
    let cancelled = false;
    const key = `${chain.config.rpcUrl}|${wallet.ownerPublicKey}|${mintText}|${payeeCanonical ?? ''}`;
    const client = createClient(chain.config);
    void observePresign({
      connection: client.connection,
      owner: new PublicKey(wallet.ownerPublicKey),
      payee: payeeCanonical ? new PublicKey(payeeCanonical) : null,
      mint,
      cluster: chain.config.explorerCluster,
    })
      .then((next) => {
        if (!cancelled) {
          setObservation({ key, value: next });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setObservation(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chain.config, mintText, payeeCanonical, wallet.ownerPublicKey]);

  const decimals = liveObservation?.mintReadable ? liveObservation.decimals : null;
  const seeded = !request && template && decimals != null ? templateLimits(template, decimals) : null;
  const cap = capTouched ?? seeded?.cap ?? null;
  const maxPay = maxTouched ?? seeded?.max ?? null;

  const requestCeiling = useMemo(() => {
    if (!request) {
      return null;
    }
    return {
      cap: request.cap,
      max: request.max,
      expiresAt: expiryFromDays(request.days, openedAt),
    };
  }, [openedAt, request]);

  const expiresAt = useMemo(() => {
    if (choice.kind === 'days') {
      const at = expiryFromDays(choice.days, openedAt);
      if (requestCeiling && at > requestCeiling.expiresAt) {
        return requestCeiling.expiresAt;
      }
      return at;
    }
    return customDateWithin(choice.iso, openedAt, requestCeiling?.expiresAt ?? null);
  }, [choice, openedAt, requestCeiling]);

  const applyLimits = (nextCap: bigint, nextMax: bigint) => {
    if (expiresAt == null) {
      return;
    }
    if (requestCeiling) {
      const clamped = clampToRequest(requestCeiling, { cap: nextCap, max: nextMax, expiresAt });
      setCapTouched(clamped.cap);
      setMaxTouched(clamped.max);
      return;
    }
    if (!template || decimals == null) {
      return;
    }
    const ceiling = templateCapCeiling(templateLimits(template, decimals).cap);
    const clamped = clampTemplate({
      capCeiling: ceiling,
      chosen: { cap: nextCap, max: nextMax, expiresAt },
    });
    setCapTouched(clamped.cap);
    setMaxTouched(clamped.max);
  };

  const capCeiling = request
    ? request.cap
    : template && decimals != null
      ? templateCapCeiling(templateLimits(template, decimals).cap)
      : null;
  const maxCeiling = cap != null && request ? (request.max < cap ? request.max : cap) : cap;

  const agentParty = partyDisplay({
    address: agentCanonical,
    claimedLabel: request?.agentLabel ?? null,
    savedName: agentCanonical ? (book[agentCanonical] ?? null) : null,
  });
  const payeeParty = partyDisplay({
    address: payeeCanonical,
    claimedLabel: request?.payeeLabel ?? null,
    savedName: payeeCanonical ? (book[payeeCanonical] ?? null) : null,
  });
  const sentence =
    cap != null && maxPay != null && expiresAt != null && decimals != null
      ? approvalSentence({
          agent: addressLine(agentParty, false).primary || 'the agent',
          payee: addressLine(payeeParty, false).primary || 'the payee',
          max: withToken(formatBaseUnits(maxPay, decimals), mintText),
          cap: withToken(formatBaseUnits(cap, decimals), mintText),
          until: formatUntilDate(expiresAt),
        })
      : null;

  const checks =
    liveObservation && cap != null
      ? evaluatePresign({
          ...liveObservation,
          cap,
          payeeHasTokenAccount: payeeFieldReady(payeeText) ? liveObservation.payeeHasTokenAccount : null,
        })
      : [];
  const showFaucet =
    wallet.ownerPublicKey != null &&
    showDevnetUsdcFaucet({
      cluster: chain.config?.explorerCluster,
      mint: mintText,
      shortfall: {
        balance: liveObservation?.ownerTokenBalance ?? null,
        needed: cap ?? 0n,
        balanceKnown: liveObservation?.mintReadable === true && cap != null,
      },
    });
  const ready = canApprove({
    checks,
    payeeReady: payeeFieldReady(payeeText),
    agentReady: agentFieldReady(agentText, wallet.ownerPublicKey, payeeCanonical),
    purposeReady: purposeFieldReady(request ? request.purpose : purpose),
    expiryReady: expiresAt != null && expiresAt > BigInt(Math.floor(openedAt / 1000)),
  });

  const selectTemplate = (id: string) => {
    const next = templateById(id);
    if (!next) {
      return;
    }
    setTemplate(next);
    setPurpose(next.fields.purpose);
    setChoice({ kind: 'days', days: Number(next.fields.expiryDays) });
    setCustomDate('');
    setDateError(null);
    setCapTouched(null);
    setMaxTouched(null);
  };

  const onChip = (days: number) => {
    if (!durationChipAllowed(days, request?.days ?? null)) {
      return;
    }
    setChoice({ kind: 'days', days });
    setCustomDate('');
    setDateError(null);
  };

  const onCustomDate = (text: string) => {
    setCustomDate(text);
    const at = customDateWithin(text, openedAt, requestCeiling?.expiresAt ?? null);
    if (!at) {
      setDateError('Use a date YYYY-MM-DD that is still ahead, and not later than this request allows.');
      return;
    }
    setDateError(null);
    setChoice({ kind: 'date', iso: text });
  };

  const saveName = async (which: 'agent' | 'payee') => {
    const address = which === 'agent' ? agentCanonical : payeeCanonical;
    if (!address) {
      return;
    }
    try {
      const next = withSavedName(book, address, nameDraft);
      await saveAddressBook(secureStore, next);
      setBook(next);
      setNaming(null);
      setNameDraft('');
      setNameError(null);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'The name could not be saved.');
    }
  };

  const onApprove = async () => {
    if (
      openingRef.current ||
      openedAddress ||
      chain.submitHeld ||
      !ready ||
      cap == null ||
      maxPay == null ||
      expiresAt == null
    ) {
      return;
    }
    openingRef.current = true;
    setFormError(null);
    try {
      const merchant = new PublicKey(payeeText.trim());
      const agent = parseOptionalAgentAddress({
        text: agentText,
        owner: wallet.ownerPublicKey,
        payee: merchant,
      });
      const result = await chain.open({
        merchant,
        cap,
        perTxMax: maxPay,
        expiresAt,
        purpose: request ? request.purpose : purpose.trim(),
        ...(request ? { mint: new PublicKey(request.mint) } : {}),
        ...(agent ? { agent } : {}),
      });
      setOpenedAddress(result.mandate.address);
      if (onOpened) {
        onOpened(result);
      } else if (firstRun) {
        router.replace('/first-run/live');
      } else {
        router.replace(`/rule/${result.mandate.address}`);
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Open failed');
      setHoldReset((current) => current + 1);
    } finally {
      openingRef.current = false;
    }
  };

  const footer = wallet.ownerPublicKey ? (
    <View style={styles.footer}>
      {formError ? <Text style={styles.body}>{formError}</Text> : null}
      {openedAddress ? (
        <Text style={styles.body}>{`Opened on chain. Rule ${openedAddress}.`}</Text>
      ) : (
        <View testID={`approve-hold-${holdReset}`}>
          <HoldToApprove
            label={wallet.busy ? 'Waiting on Seed Vault...' : 'Hold to approve rule'}
            disabled={!ready || chain.submitHeld || wallet.busy}
            resetKey={holdReset}
            onConfirm={() => {
              void onApprove();
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Decline this rule"
            onPress={() => {
              if (onDecline) {
                onDecline();
                return;
              }
              router.back();
            }}
            style={styles.decline}
          >
            <Text style={styles.declineLabel}>Decline this rule</Text>
          </Pressable>
        </View>
      )}
    </View>
  ) : null;

  const dayCount = choice.kind === 'days' ? choice.days : null;
  const maxText = maxPay != null && decimals != null ? withToken(formatBaseUnits(maxPay, decimals), mintText) : null;
  const capText = cap != null && decimals != null ? withToken(formatBaseUnits(cap, decimals), mintText) : null;
  const tokenNote = devnetTestTokenNote(mintText, chain.config?.explorerCluster ?? null);
  const paymentCount = cap != null && maxPay != null && maxPay > 0n ? cap / maxPay : null;
  const blockCount =
    paymentCount != null && paymentCount > 0n && paymentCount <= 60n ? Number(paymentCount) : BLOCK_COUNT;
  const blockLine =
    paymentCount != null && paymentCount > 0n && paymentCount <= 60n && maxText
      ? `1 block = one payment of ${maxText}`
      : maxText
        ? `${maxText} at most per payment`
        : null;

  const nudgeAmount = (which: 'max' | 'cap', direction: 1 | -1) => {
    if (cap == null || maxPay == null || decimals == null || capCeiling == null || maxCeiling == null) {
      return;
    }
    if (which === 'max') {
      applyLimits(cap, nudge(maxPay, maxCeiling, direction, decimals));
      return;
    }
    const nextCap = nudge(cap, capCeiling, direction, decimals);
    applyLimits(nextCap, maxPay > nextCap ? nextCap : maxPay);
  };

  const nudgeDays = (direction: 1 | -1) => {
    if (dayCount == null) {
      return;
    }
    const next = dayCount + direction;
    if (next < 1) {
      return;
    }
    if (request?.days != null && next > request.days) {
      return;
    }
    setChoice({ kind: 'days', days: next });
    setCustomDate('');
    setDateError(null);
  };

  return (
    <RuleScreen footer={footer}>
      {firstRun ? (
        <ProgressStrip current="approve" done={['learn', 'connect', 'agent']} />
      ) : (
        <TopBar back="Rules" />
      )}
      <ConnectGate>
        <Text style={styles.kicker}>New rule to approve</Text>
        <Text style={styles.h2}>
          {selfWrite ? 'Write the rule yourself' : (template?.title ?? (request ? 'Approve this request' : 'Build a rule'))}
        </Text>
        <Text style={styles.body}>
          {agentParty.shortAddress
            ? `Your agent, ${agentParty.shortAddress}, asks you for this rule`
            : 'Your agent asks you for this rule'}
        </Text>
        {sentence ? <Text style={styles.sentence}>{sentence}</Text> : (
          <Text style={styles.body}>Reading the mint from the chain.</Text>
        )}
        {(request ? request.purpose : purpose).trim().length > 0 ? (
          <View style={styles.purpose}>
            <Text style={styles.kicker}>What it says it is for</Text>
            <Text style={styles.purposeText}>{request ? request.purpose : purpose}</Text>
          </View>
        ) : null}
        {tokenNote ? <Text style={styles.body}>{tokenNote}</Text> : null}
        {cap != null && maxPay != null && decimals != null && capText && maxText ? (
          <View style={styles.block}>
            <View style={styles.limitHead}>
              <Text style={styles.kicker}>{`Set your agent's limits`}</Text>
              <Text style={styles.fix}>Tap + or - to change</Text>
            </View>
            <LimitDial
              label="May only pay"
              hint={payeeParty.shortAddress ?? 'Scan or paste the payee'}
              onEdit={() => {
                router.push('/scan?target=payee');
              }}
            />
            <AmountDial
              label="Most per payment"
              hint="Anything above is refused"
              value={maxText}
              spoken={`Most per payment: ${maxText}`}
              onLower={() => nudgeAmount('max', -1)}
              onRaise={() => nudgeAmount('max', 1)}
              lowerLabel="Lower the most per payment"
              raiseLabel="Raise the most per payment"
            />
            <AmountDial
              label="Most in total, ever"
              hint="Set aside for this rule only"
              value={capText}
              spoken={`Most in total: ${capText}`}
              onLower={() => nudgeAmount('cap', -1)}
              onRaise={() => nudgeAmount('cap', 1)}
              lowerLabel="Lower the total"
              raiseLabel="Raise the total"
            />
            {dayCount != null ? (
              <AmountDial
                label="Rule ends in"
                hint="After that, no more payments"
                value={`${dayCount} days`}
                spoken={`Rule ends in ${dayCount} days`}
                onLower={() => nudgeDays(-1)}
                onRaise={() => nudgeDays(1)}
                lowerLabel="End the rule sooner"
                raiseLabel="End the rule later"
              />
            ) : null}
            {paymentCount != null && capText && maxText ? (
              <View style={styles.block}>
                <Text style={styles.body}>{`The ${capText} total`}</Text>
                <Text style={styles.body}>{`${paymentCount.toString()} payments of ${maxText} at most`}</Text>
                <BlockBar
                  remaining={blockCount}
                  cap={blockCount}
                  blocks={blockCount}
                  accessibilityLabel={`${capText} set aside for this rule`}
                />
                {blockLine ? <Text style={styles.fix}>{blockLine}</Text> : null}
                {dayCount != null ? <Text style={styles.fix}>{`Rule ends in ${dayCount} days`}</Text> : null}
              </View>
            ) : null}
          </View>
        ) : null}
        {!request && template ? (
          <View style={styles.chips}>
            {BUILD_YOUR_OWN_IDS.map((id) => {
              const row = templateById(id);
              const selected = template.id === id;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityLabel={row?.title ?? id}
                  onPress={() => selectTemplate(id)}
                  style={[styles.chip, selected && styles.chipOn]}
                >
                  <Text style={[styles.chipText, selected && styles.chipTextOn]}>{row?.title ?? id}</Text>
                </Pressable>
              );
            })}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Scan a request"
              onPress={() => router.push('/scan?target=request')}
              style={styles.chip}
            >
              <Text style={styles.chipText}>Scan a request</Text>
            </Pressable>
          </View>
        ) : null}

        <PartyBlock
          role="Agent"
          party={agentParty}
          revealed={revealed.agent}
          onReveal={() => setRevealed((prev) => ({ ...prev, agent: !prev.agent }))}
          onSave={() => {
            setNaming('agent');
            setNameDraft('');
            setNameError(null);
          }}
        />
        {!request ? (
          <>
            <Field
              label="Agent"
              value={agentText}
              onChangeText={setAgentText}
              placeholder="scan or paste the agent address"
              hint="Leave this empty only for a test. Opening then creates a key on this phone."
            />
            <AddressActions target="agent" onAddress={setAgentText} onInvalid={setFormError} />
            {agentText.trim().length > 0 &&
            !agentFieldReady(agentText, wallet.ownerPublicKey, payeeCanonical) ? (
              <Text style={styles.body}>That agent address cannot be used for this rule.</Text>
            ) : null}
          </>
        ) : null}

        <PartyBlock
          role="Payee"
          party={payeeParty}
          revealed={revealed.payee}
          onReveal={() => setRevealed((prev) => ({ ...prev, payee: !prev.payee }))}
          onSave={() => {
            setNaming('payee');
            setNameDraft('');
            setNameError(null);
          }}
        />
        {!request ? (
          <>
            <Field
              label="Payee"
              value={payeeText}
              onChangeText={setPayeeText}
              placeholder="scan or paste the payee address"
            />
            <AddressActions target="payee" onAddress={setPayeeText} onInvalid={setFormError} />
          </>
        ) : null}

        {naming && (naming === 'agent' ? agentCanonical : payeeCanonical) ? (
          <View style={styles.block}>
            <Field label="Name on this phone" value={nameDraft} onChangeText={setNameDraft} />
            <Button
              label="Save this name"
              accessibilityLabel="Save this name"
              invert={false}
              onPress={() => {
                void saveName(naming);
              }}
            />
            {nameError ? <Text style={styles.body}>{nameError}</Text> : null}
          </View>
        ) : null}

        <View style={styles.chips}>
          {DURATION_DAYS.map((days) => {
            const allowed = durationChipAllowed(days, request?.days ?? null);
            const selected = choice.kind === 'days' && choice.days === days;
            return (
              <Pressable
                key={days}
                accessibilityRole="button"
                accessibilityLabel={`${days} days`}
                accessibilityState={{ disabled: !allowed, selected }}
                disabled={!allowed}
                onPress={() => onChip(days)}
                style={[styles.chip, selected && styles.chipOn, !allowed && styles.chipOff]}
              >
                <Text style={[styles.chipText, selected && styles.chipTextOn]}>{days} days</Text>
              </Pressable>
            );
          })}
        </View>
        <Field
          label="Custom date"
          value={customDate}
          onChangeText={onCustomDate}
          placeholder="YYYY-MM-DD"
        />
        {dateError ? <Text style={styles.body}>{dateError}</Text> : null}

        {request ? (
          <Text style={styles.body}>{request.purpose}</Text>
        ) : (
          <Field label="Purpose" value={purpose} onChangeText={setPurpose} multiline />
        )}
        {!request && !purposeFieldReady(purpose) ? (
          <Text style={styles.body}>Add a purpose in your own words.</Text>
        ) : null}

        {!payeeFieldReady(payeeText) ? (
          <Text style={styles.body}>Scan or paste the payee address.</Text>
        ) : null}
        {checks
          .filter((check) => !check.ok && (check.id !== 'payee' || payeeFieldReady(payeeText)))
          .map((check) => (
            <View key={check.id} style={styles.check}>
              <Text style={styles.body}>{check.message}</Text>
              <Text style={styles.fix}>{check.fix}</Text>
            </View>
          ))}
        {showFaucet && wallet.ownerPublicKey ? <GetDevnetUsdc owner={wallet.ownerPublicKey} /> : null}
        {!liveObservation && wallet.ownerPublicKey && mintText ? (
          <Text style={styles.body}>Checking the wallet, the token, and the network.</Text>
        ) : null}
        {!mintText ? <Text style={styles.body}>This app has no token mint configured.</Text> : null}
      </ConnectGate>
    </RuleScreen>
  );
}

function nudge(current: bigint, ceiling: bigint, direction: 1 | -1, decimals: number): bigint {
  if (ceiling <= 0n) {
    return 0n;
  }
  const unit = 10n ** BigInt(Math.max(0, decimals));
  let stepped = current + BigInt(direction) * unit;
  if (stepped < 0n) {
    stepped = 0n;
  }
  if (stepped > ceiling) {
    stepped = ceiling;
  }
  return capFromRing({ ceiling, fraction: fractionFromAmount(stepped, ceiling) });
}

function AmountDial({
  label,
  hint,
  value,
  spoken,
  onLower,
  onRaise,
  lowerLabel,
  raiseLabel,
}: {
  label: string;
  hint: string;
  value: string;
  spoken: string;
  onLower: () => void;
  onRaise: () => void;
  lowerLabel: string;
  raiseLabel: string;
}) {
  return (
    <View style={styles.dial}>
      <View style={styles.dialCopy}>
        <Text style={styles.eyebrow}>{label}</Text>
        <Text style={styles.fix}>{hint}</Text>
      </View>
      <Text accessibilityLabel={spoken} style={styles.reel}>
        {value}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel={lowerLabel} onPress={onLower} style={styles.step}>
        <Text style={styles.stepText}>-</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={raiseLabel} onPress={onRaise} style={styles.stepOn}>
        <Text style={styles.stepOnText}>+</Text>
      </Pressable>
    </View>
  );
}

function LimitDial({ label, hint, onEdit }: { label: string; hint: string; onEdit: () => void }) {
  return (
    <View style={styles.dial}>
      <View style={styles.dialCopy}>
        <Text style={styles.eyebrow}>{label}</Text>
        <Text style={styles.reelSmall}>{hint}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`Edit who your agent may pay, ${hint}`} onPress={onEdit} style={styles.edit}>
        <Text style={styles.editText}>Edit</Text>
      </Pressable>
    </View>
  );
}

function PartyBlock({
  role,
  party,
  revealed,
  onReveal,
  onSave,
}: {
  role: string;
  party: ReturnType<typeof partyDisplay>;
  revealed: boolean;
  onReveal: () => void;
  onSave: () => void;
}) {
  if (!party.fullAddress) {
    return null;
  }
  const line = addressLine(party, revealed);
  return (
    <View style={styles.block}>
      <Text style={styles.eyebrow}>{role}</Text>
      {party.savedName ? <Text style={styles.name}>{party.savedName}</Text> : null}
      <View style={styles.partyRow}>
        {party.shortAddress ? <Text style={styles.body}>{party.shortAddress}</Text> : null}
        {party.claim ? <Text style={styles.claim}>{party.claim}</Text> : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Show full address" onPress={onReveal}>
        <Text style={styles.link}>{line.full ?? 'Show full address'}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`Save a name for the ${role.toLowerCase()}`} onPress={onSave}>
        <Text style={styles.link}>Save a name</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  h2: {
    color: colors.text,
    fontSize: 32,
    fontFamily: fonts.serif,
  },
  sentence: {
    color: colors.text,
    fontSize: 22,
    lineHeight: 30,
    fontFamily: fonts.serif,
  },
  body: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 22,
  },
  fix: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  eyebrow: {
    color: colors.muted,
    fontSize: 11,
    fontFamily: fonts.mono,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  name: {
    color: colors.text,
    fontSize: 22,
    fontFamily: fonts.serif,
  },
  claim: {
    color: colors.brass,
    fontSize: 14,
  },
  link: {
    color: colors.text,
    fontSize: 14,
    textDecorationLine: 'underline',
  },
  partyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'baseline',
  },
  block: {
    gap: 8,
    alignSelf: 'stretch',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipOn: {
    backgroundColor: colors.invert,
    borderColor: colors.invert,
  },
  chipOff: {
    opacity: 0.35,
  },
  chipText: {
    color: colors.body,
    fontSize: 14,
    fontWeight: '500',
  },
  chipTextOn: {
    color: colors.invertText,
  },
  check: {
    gap: 4,
    alignSelf: 'stretch',
  },
  footer: {
    gap: 8,
  },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  purpose: {
    gap: 4,
    borderLeftWidth: 2,
    borderLeftColor: colors.brass,
    paddingLeft: space.lg,
  },
  purposeText: {
    fontFamily: fonts.serifItalic,
    fontSize: 16,
    lineHeight: 22,
    color: colors.body,
  },
  limitHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.md,
  },
  dial: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 64,
    paddingVertical: space.md,
    paddingLeft: space.xxl,
    paddingRight: space.md,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  dialCopy: {
    flex: 1,
    gap: 3,
  },
  reel: {
    minWidth: 56,
    fontFamily: fonts.serif,
    fontSize: 28,
    lineHeight: 32,
    color: colors.brass,
    textAlign: 'center',
  },
  reelSmall: {
    fontFamily: fonts.sansSemibold,
    fontSize: 17,
    color: colors.bone,
  },
  step: {
    width: 44,
    height: 44,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.brassSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepOn: {
    width: 44,
    height: 44,
    borderRadius: radii.control,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: {
    fontFamily: fonts.serif,
    fontSize: 22,
    color: colors.brass,
  },
  stepOnText: {
    fontFamily: fonts.serif,
    fontSize: 22,
    color: colors.forest,
  },
  edit: {
    minWidth: 64,
    minHeight: 44,
    paddingHorizontal: space.xl,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.brassSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editText: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.brass,
  },
  decline: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  declineLabel: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    color: colors.muted,
  },
});
