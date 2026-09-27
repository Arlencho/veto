import { StyleSheet, Text, TextInput, View } from 'react-native';

import { canonicalAddress, parseRuleRequest, type RuleRequestV1 } from '../../lib/ruleRequest';
import { truncateAddress } from '../../lib/wallet';
import { colors, fonts, radii, space, type as typeScale } from '../theme';
import { BrassButton, FirstRunChrome, QuietButton, type ScreenView } from './Chrome';

export type AgentRequestFacts = {
  payee: string;
  perPayment: string;
  total: string;
  days: string;
  purpose: string;
};

export function factsFromRequest(
  request: RuleRequestV1,
  formatAmount: (amount: bigint) => string | null,
): AgentRequestFacts | null {
  const perPayment = formatAmount(request.max);
  const total = formatAmount(request.cap);
  if (!perPayment || !total) {
    return null;
  }
  return {
    payee: truncateAddress(request.payee, 4),
    perPayment,
    total,
    days: String(request.days),
    purpose: request.purpose,
  };
}

export function NameAgentScreen({
  cluster,
  address,
  name,
  onName,
  facts,
  factsPending = false,
  error = null,
  busy = false,
  onReview,
  onReject,
  onBack,
  view,
  paste,
  onPaste,
  showPaste = false,
}: {
  cluster: string | null;
  address: string | null;
  name: string;
  onName: (value: string) => void;
  facts: AgentRequestFacts | null;
  factsPending?: boolean;
  error?: string | null;
  busy?: boolean;
  onReview: () => void;
  onReject: () => void;
  onBack?: () => void;
  view?: ScreenView;
  paste?: string;
  onPaste?: (value: string) => void;
  showPaste?: boolean;
}) {
  const pastedText = showPaste ? (paste ?? '').trim() : '';
  const validPaste = Boolean(canonicalAddress(pastedText)) || parseRuleRequest(pastedText).ok;
  const pasteError = pastedText && !validPaste
    ? 'That is not an agent address or a rule request.'
    : null;
  const resolved =
    view ?? (showPaste ? 'normal' : error ? 'error' : address ? 'normal' : 'empty');
  return (
    <FirstRunChrome
      stage="agent"
      cluster={cluster}
      title="Agent found"
      onBack={onBack}
      view={resolved}
      error={pasteError ?? error}
      empty="No agent yet. Scan a code, paste an address, or create a test agent."
      footer={
        <>
          <BrassButton label="Review the rule" onPress={onReview} busy={busy} disabled={!address && !validPaste} />
          <QuietButton label="Not my agent" onPress={onReject} />
        </>
      }
    >
      <Text style={styles.kicker}>Your agent, found</Text>
      {address ? <Text style={styles.address}>{truncateAddress(address, 4)}</Text> : null}
      <Text style={styles.body}>
        {facts
          ? 'Its address. It sent you a rule request.'
          : 'Its address. Nothing is approved yet.'}
      </Text>
      {showPaste && onPaste ? (
        <TextInput
          accessibilityLabel="Paste your agent's address"
          value={paste ?? ''}
          onChangeText={onPaste}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Paste an address or a rule request"
          placeholderTextColor={colors.muted}
          style={styles.input}
        />
      ) : null}
      <Text style={styles.label}>Name your agent</Text>
      <Text style={styles.hint}>Only you see this name. Change it if you like.</Text>
      <TextInput
        accessibilityLabel="Name your agent"
        value={name}
        onChangeText={onName}
        placeholder="Name"
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
      <Text style={styles.label}>What it is asking for</Text>
      <Text style={styles.hint}>Nothing is approved yet</Text>
      {factsPending ? <Text style={styles.body}>Reading the token amount from the chain.</Text> : null}
      {facts ? (
        <View style={styles.facts}>
          <Fact label="Pay only" value={facts.payee} />
          <Fact label="Most per payment" value={facts.perPayment} />
          <Fact label="Total, ever" value={facts.total} />
          <Fact label="Ends after" value={`${facts.days} days`} />
          <Text style={styles.hint}>Purpose, in its words</Text>
          <Text style={styles.purpose}>{facts.purpose}</Text>
          <Text style={styles.hint}>You can change every number before you approve.</Text>
        </View>
      ) : (
        <Text style={styles.body}>You can set who it may pay, and the limits, when you review the rule.</Text>
      )}
    </FirstRunChrome>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.hint}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: colors.brass,
  },
  address: {
    fontFamily: fonts.serif,
    fontSize: 28,
    lineHeight: 32,
    color: colors.bone,
  },
  body: {
    ...typeScale.body,
  },
  label: {
    fontFamily: fonts.sansBold,
    fontSize: 16,
    color: colors.bone,
  },
  hint: {
    ...typeScale.caption,
  },
  input: {
    minHeight: 48,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    color: colors.bone,
    fontFamily: fonts.sans,
    fontSize: 16,
    paddingHorizontal: space.xl,
  },
  facts: {
    gap: space.md,
  },
  fact: {
    gap: 2,
  },
  factValue: {
    fontFamily: fonts.serif,
    fontSize: 22,
    lineHeight: 26,
    color: colors.bone,
  },
  purpose: {
    fontFamily: fonts.serifItalic,
    fontSize: 16,
    lineHeight: 22,
    color: colors.body,
  },
});
