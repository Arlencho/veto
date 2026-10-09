import { redactRpc } from '../lib/rpcPrivacy';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';

import { ConnectGate } from '../components/ConnectGate';
import { EmptyState } from '../components/EmptyState';
import { Field } from '../components/Field';
import { ReadState } from '../components/ReadState';
import {
  BrassButton,
  Choice,
  FormatToggle,
  GhostButton,
  Glow,
  Kicker,
  Rise,
  ScreenHeader,
  SealNote,
} from '../components/records/chrome';
import { decisionFace, decisionWhen } from '../components/records/copy';
import { Screen } from '../components/Screen';
import { colors, fonts } from '../components/theme';
import { KIND_PAID, KIND_REFUSED } from '../lib/constants';
import {
  COMPLETENESS_NOTE,
  findLedgerDecision,
  formatExport,
  loadedRuleMatchesDecision,
  parseDayBound,
  parseDecisionId,
  rowToExportable,
  selectExportRows,
  SHARE_RULE_MISMATCH,
  signedExportRows,
  type ChargeKind,
  type ShareScope,
} from '../lib/exportRecord';
import { explorerTxUrl } from '../lib/format';
import { mayClaimAbsence } from '../lib/mandateRead';
import { displayPurpose } from '../lib/ruleView';
import { useChain } from '../lib/useChain';

type Shape = 'csv' | 'json';
type ScopeChoice = 'decision' | 'date_range' | 'rule';

function utcDay(ms: number): string {
  const date = new Date(ms);
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function ShareScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = rawId ? decodeURIComponent(rawId) : '';
  const parsed = id ? parseDecisionId(id) : null;
  const chain = useChain();
  const router = useRouter();
  const mandate = chain.mandate;
  const kind: ChargeKind | null =
    parsed?.kind === KIND_PAID ? 'paid' : parsed?.kind === KIND_REFUSED ? 'refused' : null;
  const [choice, setChoice] = useState<ScopeChoice>(kind ? 'decision' : 'rule');
  const [shape, setShape] = useState<Shape>('csv');
  const [fromDay, setFromDay] = useState(() => utcDay(Date.now()));
  const [toDay, setToDay] = useState(() => utcDay(Date.now()));
  const [error, setError] = useState<string | null>(null);
  const rpcUrl = chain.config?.rpcUrl ?? '';
  const cluster = chain.config?.explorerCluster ?? 'devnet';

  const exportable = useMemo(() => {
    if (!mandate) {
      return [];
    }
    if (!loadedRuleMatchesDecision(mandate.address, parsed?.mandate ?? null)) {
      return [];
    }
    return chain.rows
      .map((row) => rowToExportable(row, mandate.address))
      .filter((row): row is NonNullable<typeof row> => row != null);
  }, [chain.rows, mandate, parsed]);

  const scope: ShareScope | null = useMemo(() => {
    if (choice === 'decision') {
      if (!parsed || !kind) {
        return null;
      }
      return { type: 'decision', nonce: parsed.nonce, kind, timestamp: parsed.ts };
    }
    if (choice === 'date_range') {
      try {
        return {
          type: 'date_range',
          from: parseDayBound(fromDay, false),
          to: parseDayBound(toDay, true),
        };
      } catch {
        return null;
      }
    }
    return { type: 'rule' };
  }, [choice, fromDay, kind, parsed, toDay]);

  const selected = scope ? selectExportRows(exportable, scope) : [];
  const signed = signedExportRows(selected);
  const count = signed.length;
  const row = findLedgerDecision(chain.rows, parsed, mandate?.address);
  const face = row
    ? decisionFace(row, chain.decimals, mandate?.perTxMax, chain.nowMs, {
        payee: mandate?.merchant,
        amounts: 'exact',
        mint: mandate?.mint,
      })
    : null;
  const purpose = mandate ? displayPurpose(mandate.purpose) : '';
  const noun = choice === 'decision' ? 'this decision' : choice === 'date_range' ? 'this date range' : 'everything under this rule';

  const onExport = async () => {
    setError(null);
    try {
      if (!mandate || !chain.config) {
        throw new Error(chain.configError ?? 'Config is missing');
      }
      if (!chain.genesisHash) {
        throw new Error('Genesis hash has not been read from this RPC yet. Pull to retry.');
      }
      if (!scope) {
        throw new Error('Choose a scope the export can name.');
      }
      if (parsed && !loadedRuleMatchesDecision(mandate.address, parsed.mandate)) {
        throw new Error(SHARE_RULE_MISMATCH);
      }
      const body = formatExport({
        rows: exportable,
        scope,
        shape,
        ctx: {
          cluster: chain.config.explorerCluster,
          genesisHash: chain.genesisHash,
          programId: chain.config.programId,
          mandate,
        },
      });
      await Share.share({
        message: body,
        title: shape === 'csv' ? 'Veto decisions.csv' : 'Veto decisions.json',
      });
    } catch (err) {
      setError(err instanceof Error ? redactRpc(err.message) : 'Export failed');
    }
  };

  const onShareLink = async () => {
    setError(null);
    const links = signed
      .map((item) => item.signature)
      .filter((signature): signature is string => typeof signature === 'string' && signature.length > 0)
      .map((signature) => explorerTxUrl(signature, cluster, rpcUrl));
    if (links.length === 0) {
      setError('This record has no transaction signature on the chain yet.');
      return;
    }
    try {
      await Share.share({
        message: links.join('\n'),
        title: 'Veto on the blockchain',
      });
    } catch (err) {
      setError(err instanceof Error ? redactRpc(err.message) : 'Could not share the link');
    }
  };

  const decisionHint = face
    ? `${face.title}. ${row ? decisionWhen(row.ts, chain.nowMs) : ''}`
    : 'Export is complete over paid and refused charges. A one-time allowance is listed in the app and is not this file.';

  return (
    <Screen>
      <Glow />
      <ScreenHeader
        title="Share or export"
        cluster={cluster}
        backLabel="Decisions"
        onBack={() => router.back()}
        onHelp={() => router.push('/help')}
      />
      <ConnectGate>
        {!mayClaimAbsence(chain.mandateStatus) ? (
          <ReadState
            status={chain.mandateStatus}
            empty="No rule is selected. Switch on the Rules tab first."
          />
        ) : !mandate ? (
          <EmptyState>No rule is selected. Switch on the Rules tab first.</EmptyState>
        ) : parsed && !loadedRuleMatchesDecision(mandate.address, parsed.mandate) ? (
          <EmptyState>{SHARE_RULE_MISMATCH}</EmptyState>
        ) : (
          <View style={styles.block}>
            <Rise delayMs={80}>
              <Text style={styles.h1}>Export the record.</Text>
              <Text style={styles.lead}>
                A file of what happened under your rule <Text style={styles.italic}>{purpose}</Text>.
              </Text>
            </Rise>
            <Rise delayMs={180}>
              <Kicker>What to put in the file</Kicker>
              <View style={styles.choices}>
                <Choice
                  selected={choice === 'decision'}
                  title="This decision"
                  hint={decisionHint}
                  disabled={!kind}
                  onPress={() => {
                    if (kind) {
                      setChoice('decision');
                    }
                  }}
                />
                <Choice
                  selected={choice === 'date_range'}
                  title="A date range"
                  hint="You pick the first and last day."
                  onPress={() => setChoice('date_range')}
                />
                <Choice
                  selected={choice === 'rule'}
                  title="Everything under this rule"
                  hint="Every payment and refusal under this rule."
                  onPress={() => setChoice('rule')}
                />
              </View>
              {choice === 'date_range' ? (
                <View style={styles.dates}>
                  <Field label="From (UTC)" value={fromDay} onChangeText={setFromDay} placeholder="YYYY-MM-DD" />
                  <Field label="To (UTC)" value={toDay} onChangeText={setToDay} placeholder="YYYY-MM-DD" />
                </View>
              ) : null}
            </Rise>
            <Rise delayMs={320}>
              <Kicker>File format</Kicker>
              <FormatToggle shape={shape} onChange={setShape} />
            </Rise>
            <SealNote>
              <Text style={styles.proveLead}>What the file proves: </Text>
              it lists every payment and refusal, with the reason and time, and anyone can check each line
              against the blockchain. {COMPLETENESS_NOTE} {count} signed {count === 1 ? 'row' : 'rows'} in this
              file.
            </SealNote>
            <BrassButton
              label={
                shape === 'csv'
                  ? `Save ${noun} as a CSV file`
                  : `Save ${noun} as a JSON file`
              }
              onPress={() => {
                void onExport();
              }}
            />
            <GhostButton
              label="Share the blockchain link instead"
              onPress={() => {
                void onShareLink();
              }}
            />
            {error ? <Text style={styles.err}>{error}</Text> : null}
            <Text style={styles.foot}>
              Nothing is signed. The file only reads what is already on the blockchain.
            </Text>
          </View>
        )}
      </ConnectGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 14,
    alignSelf: 'stretch',
  },
  h1: {
    fontFamily: fonts.serif,
    fontSize: 32,
    lineHeight: 36,
    color: colors.bone,
  },
  lead: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 21,
    color: colors.body,
  },
  italic: {
    fontFamily: fonts.serifItalic,
    fontSize: 15,
    color: colors.bone,
  },
  choices: {
    gap: 8,
    marginTop: 8,
  },
  dates: {
    gap: 10,
    marginTop: 8,
  },
  proveLead: {
    color: colors.bone,
    fontFamily: fonts.sansBold,
  },
  err: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  foot: {
    textAlign: 'center',
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
  },
});
