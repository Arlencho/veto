import { Connection, PublicKey } from '@solana/web3.js';
import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, StyleSheet, Text, View } from 'react-native';
import type { MandateAccount } from '../lib/mandate';
import { explorerTxUrl } from '../lib/format';
import { knownToken, formatTokenAmount } from '../lib/tokens';
import { prepareTestRequests, runTestRequests, testRequestFailure, testRequestsVisible, type TestRequestUpdate } from '../lib/testRequests';
import { useChain } from '../lib/useChain';
import { useWallet } from '../lib/useWallet';
import { Button } from './Button';
import { colors } from './theme';

export function TestRequests({ mandate }: { mandate: MandateAccount | null }) {
  const chain = useChain();
  const wallet = useWallet();
  const held = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [busy, setBusy] = useState(false);
  const [updates, setUpdates] = useState<TestRequestUpdate[]>([]);
  const visible = testRequestsVisible(mandate, wallet.agentPublicKey, chain.config?.explorerCluster ?? null, BigInt(Math.floor(now / 1000))) && wallet.cluster === 'devnet' && !(chain.tradeRules ?? []).some(rule => rule.address === mandate?.address);
  const report = (update: TestRequestUpdate) => setUpdates(rows => [...rows, update]);
  const release = () => { held.current = false; setBusy(false); };
  const start = async () => {
    if (held.current || !visible || !mandate || !chain.config || !wallet.ownerPublicKey || wallet.busy || chain.submitHeld) return;
    held.current = true;
    setBusy(true);
    setUpdates([]);
    const options = {
      connection: new Connection(chain.config.rpcUrl, 'confirmed'),
      programId: new PublicKey(chain.config.programId), cluster: chain.config.explorerCluster,
      address: mandate.address, owner: wallet.ownerPublicKey,
      getAgentPublicKey: wallet.getAgentPublicKey, signWithAgent: wallet.signWithAgent, signAndSend: wallet.signAndSend, report,
    };
    try {
      const plan = await prepareTestRequests(options);
      const shown = (amount: bigint) => formatTokenAmount(amount, plan.decimals, plan.rule.mint);
      const payment = plan.paid === null
        ? 'The paid request will be skipped because the remaining cap is zero.'
        : `One payment of ${shown(plan.paid)} within the per-payment limit goes to payee ${plan.rule.merchant}.`;
      const token = knownToken(plan.rule.mint) ? '' : ` Amounts are in token ${plan.rule.mint}.`;
      Alert.alert('Send two test requests?', `${payment} One request of ${shown(plan.refused)}, just above the per-payment limit, will be refused.${token} If the test agent has less than 0.005 SOL for fees, your wallet first sends it 0.01 devnet SOL. This is the only owner signature requested.`, [
        { text: 'Cancel', style: 'cancel', onPress: release },
        { text: 'Send requests', onPress: () => {
          void (async () => {
            try {
              await runTestRequests(options, plan);
            } finally {
              try { await chain.refresh(); } catch { report({ text: 'Could not refresh Decisions. Pull to refresh when the connection returns.' }); }
              release();
            }
          })();
        } },
      ], { cancelable: false });
    } catch (error) {
      report({ text: testRequestFailure(error) });
      release();
    }
  };
  if (!visible && updates.length === 0) return null;
  return <View style={styles.panel}>
    {visible ? <Button label={busy ? 'Sending test requests…' : 'Send two test requests'} busy={busy} disabled={wallet.busy || chain.submitHeld} onPress={() => { void start(); }} /> : null}
    {updates.map((update, index) => <View key={index}>
      <Text accessibilityLiveRegion="polite" style={styles.text}>{update.text}</Text>
      {update.signature ? <Text accessibilityRole="link" style={styles.link} onPress={() => {
        void Linking.openURL(explorerTxUrl(update.signature!, 'devnet', '')).catch(() => report({ text: 'Could not open the explorer. Try the link again.' }));
      }}>View transaction on devnet explorer</Text> : null}
    </View>)}
  </View>;
}
const styles = StyleSheet.create({
  panel: { gap: 12 },
  text: { color: colors.body, fontSize: 15, lineHeight: 22 },
  link: { color: colors.text, textDecorationLine: 'underline', paddingVertical: 12 },
});
