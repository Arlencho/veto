import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CHAIN_BUSY, CHAIN_UNREACHABLE, type ReadFace } from '../../lib/mandateRead';
import { agentsHeading, networkBadge, type AgentRecord } from '../../lib/grade';
import { clusterNotice } from '../../lib/wallet';
import { StatTile } from '../backglass/StatTile';
import { QuietReading } from '../QuietRefresh';
import { RuleReadPill } from '../RuleReadPill';
import { colors, fonts, radii, space } from '../theme';
import type { AgentScreenData } from './useAgentHistories';
import { Cabinet, Chevron, GradeFace, HelpMark, NetworkPill, StatusLine, Wordmark } from './chrome';

function agentFace(status: AgentScreenData['status']): ReadFace {
  if (status === 'ready' || status === 'empty') {
    return 'proven';
  }
  if (status === 'error') {
    return 'unavailable';
  }
  return 'reading';
}

function transportText(text: string): boolean {
  if (/missing/i.test(text)) {
    return false;
  }
  return /\brpc\b|rate limit|\b429\b/i.test(text);
}

function loadingCopy(notice: string | null | undefined, error: string | null): string {
  const raw = notice ?? error;
  if (raw && transportText(raw)) {
    return CHAIN_BUSY;
  }
  if (notice) {
    return notice;
  }
  return 'Reading your agents from the blockchain.';
}

function failureCopy(notice: string | null | undefined, error: string | null): string {
  const raw = notice ?? error;
  if (!raw || transportText(raw)) {
    return CHAIN_UNREACHABLE;
  }
  return raw;
}

export function AgentsScreen({
  data,
  onOpenAgent,
  onHowGrades,
  onNameAgent,
}: {
  data: AgentScreenData;
  onOpenAgent: (agent: string) => void;
  onHowGrades: () => void;
  onNameAgent?: (agent: string, name: string) => void;
}) {
  return (
    <Cabinet
      refreshing={data.refreshing}
      onRefresh={data.refresh}
      showReading={false}
    >
      <View style={styles.header}>
        <View style={styles.brand}>
          <Wordmark />
          <NetworkPill label={networkBadge(data.cluster, 'name')} />
        </View>
        <View style={styles.headerRight}>
          <RuleReadPill face={agentFace(data.status)} liveCount={data.liveRules} />
          <HelpMark onPress={onHowGrades} />
        </View>
      </View>

      <View style={styles.belowHeader}>
        <Text style={styles.notice}>{clusterNotice(data.cluster)}</Text>
        <QuietReading busy={data.refreshing} />
      </View>

      {data.status === 'loading' ? <StatusLine>{loadingCopy(data.notice, data.error)}</StatusLine> : null}
      {data.status === 'error' ? <StatusLine>{failureCopy(data.notice, data.error)}</StatusLine> : null}
      {data.status === 'ready' && data.notice ? <StatusLine>{failureCopy(data.notice, null)}</StatusLine> : null}
      {data.status === 'empty' ? (
        <StatusLine>No agent is on a rule yet. A grade appears after a rule is opened.</StatusLine>
      ) : null}

      {data.status === 'ready' ? (
        <>
          <View style={styles.kickerRow}>
            <Text style={styles.kicker}>Your agents</Text>
            <Text style={styles.kickerMeta}>{agentsHeading(data.agents)}</Text>
          </View>
          <View style={styles.list}>
            {data.agents.map((agent) => (
              <AgentCard
                key={agent.agent}
                agent={agent}
                onPress={() => onOpenAgent(agent.agent)}
                onNameAgent={onNameAgent}
              />
            ))}
          </View>
        </>
      ) : null}

      {data.status === 'ready' || data.status === 'empty' ? (
        <Text style={styles.footer}>
          A grade describes behaviour, not safety.{' '}
          <Text style={styles.link} onPress={onHowGrades} accessibilityRole="link">
            See how grades work
          </Text>
        </Text>
      ) : null}
    </Cabinet>
  );
}

function AgentCard({
  agent,
  onPress,
  onNameAgent,
}: {
  agent: AgentRecord;
  onPress: () => void;
  onNameAgent?: (agent: string, name: string) => void;
}) {
  const one = agent.rules.length === 1 ? agent.rules[0] : null;
  const days = agent.daysValue.split(' of ');
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const nameControls = !agent.named ? (
    naming ? (
      <View style={styles.nameRow}>
        <TextInput
          accessibilityLabel="Agent name"
          value={draft}
          onChangeText={setDraft}
          placeholder="A name you will recognise"
          placeholderTextColor={colors.muted}
          autoCorrect={false}
          style={styles.nameInput}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save agent name"
          onPress={() => {
            const trimmed = draft.trim();
            if (!trimmed) {
              setNameError('Enter a name.');
              return;
            }
            setNameError(null);
            onNameAgent?.(agent.agent, trimmed);
            setNaming(false);
          }}
          style={styles.nameSave}
        >
          <Text style={styles.nameSaveText}>Save</Text>
        </Pressable>
        {nameError ? <Text style={styles.nameError}>{nameError}</Text> : null}
      </View>
    ) : (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Name this agent"
        onPress={() => setNaming(true)}
        style={styles.nameAction}
      >
        <Text style={styles.nameActionText}>Name this agent</Text>
      </Pressable>
    )
  ) : null;
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open the full record of ${agent.name}. Grade: ${agent.grade.label}.`}
        onPress={onPress}
        style={styles.cardBody}
      >
        <View style={styles.cardTop}>
          <Text style={styles.name}>{agent.name}</Text>
          <View style={styles.address}>
            <Text style={styles.addressText}>{agent.shortAddress}</Text>
            <Chevron />
          </View>
        </View>
        {nameControls}
        {one ? (
          <Text style={styles.under} numberOfLines={1}>
            Under your rule <Text style={styles.purpose}>{one.purpose}</Text>
          </Text>
        ) : (
          <Text style={styles.under}>{`Under ${agent.rules.length} of your rules`}</Text>
        )}
        <GradeFace grade={agent.grade} detail={agent.cardLine} compact />
        <View style={styles.stats}>
          <StatTile value={String(agent.grade.paid)} label="paid, inside its rule" valueColor={colors.paid} />
          <StatTile value={String(agent.grade.outside)} label="asked outside" valueColor={colors.refused} />
          <StatTile
            value={String(agent.grade.allowances)}
            label="allowed once by you"
            valueColor={agent.grade.allowances > 0 ? colors.amber : colors.bone}
          />
          <StatTile
            value={days[0] ?? agent.daysValue}
            suffix={days[1] ? `of ${days[1]}` : undefined}
            label={agent.daysCaption}
          />
        </View>
        {agent.spend ? (
          <View style={styles.spendRow}>
            <Text style={styles.spend}>
              Can still spend <Text style={styles.spendNum}>{agent.spend.remainingLabel}</Text> of your {agent.spend.capLabel}
            </Text>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.round(agent.spend.ratio * 100)}%` }]} />
            </View>
          </View>
        ) : (
          <Text style={styles.spend}>Open the record for what each rule can still spend.</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.xxxl,
    paddingLeft: space.screen,
    paddingRight: space.xl,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  belowHeader: {
    paddingHorizontal: space.screen,
    paddingTop: space.lg,
    gap: space.sm,
  },
  notice: {
    color: colors.body,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: fonts.sans,
  },
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: space.screen,
    paddingTop: space.xl,
  },
  kicker: {
    fontFamily: fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1.9,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  kickerMeta: { fontFamily: fonts.sans, fontSize: 12, color: colors.muted, flexShrink: 1, textAlign: 'right' },
  list: { gap: 7, paddingHorizontal: space.screen, paddingTop: space.md },
  card: {
    gap: 5,
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  cardBody: { gap: 5 },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  name: { fontFamily: fonts.serifRegular, fontSize: 18, color: colors.bone, flexShrink: 1 },
  address: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  addressText: { fontFamily: fonts.sans, fontSize: 11, color: colors.muted },
  nameAction: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  nameActionText: { fontFamily: fonts.sansBold, fontSize: 13, color: colors.brass },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  nameInput: {
    flex: 1,
    minWidth: 120,
    minHeight: 36,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.stat,
    paddingHorizontal: 10,
    color: colors.bone,
    fontFamily: fonts.sans,
    fontSize: 14,
  },
  nameSave: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: radii.stat,
    backgroundColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameSaveText: { fontFamily: fonts.sansBold, fontSize: 13, color: colors.forest },
  nameError: { fontFamily: fonts.sans, fontSize: 12, color: colors.refused },
  under: { fontFamily: fonts.sans, fontSize: 12, color: colors.muted },
  purpose: { fontFamily: fonts.serifItalic, color: colors.body },
  stats: { flexDirection: 'row', gap: 6 },
  spendRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  spend: { fontFamily: fonts.sans, fontSize: 12, color: colors.body, flexShrink: 1 },
  spendNum: { fontFamily: fonts.serifRegular, fontSize: 15, color: colors.bone },
  track: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.lampOff, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: colors.brass },
  footer: {
    marginHorizontal: space.screen,
    marginTop: space.md,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
  },
  link: { fontFamily: fonts.sansBold, color: colors.brass },
});
