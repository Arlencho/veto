import { useRouter } from 'expo-router';
import { useEffect, useState, type ComponentType } from 'react';
import { ActivityIndicator } from 'react-native';

import { loadAddressBook, saveAddressBook, withSavedName } from '../../lib/addressBook';
import type { OpenMandateResult } from '../../lib/chain';
import { formatTokenAmount } from '../../lib/tokens';
import { secureStore } from '../../lib/mwa';
import { canonicalAddress, parseRuleRequest, type RuleRequestV1 } from '../../lib/ruleRequest';
import { useChain } from '../../lib/useChain';
import { useWallet } from '../../lib/useWallet';
import { colors } from '../theme';
import { AddAgentScreen } from './AddAgentScreen';
import { factsFromRequest, NameAgentScreen } from './NameAgentScreen';
import { WalletConnectedScreen } from './WalletConnectedScreen';

type Stage = 'connected' | 'agent' | 'paste' | 'name' | 'approve' | 'live' | 'setup' | 'alerts';

export function FirstRunGuide({ onFinish }: { onFinish: () => void }) {
  const wallet = useWallet();
  const chain = useChain();
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('connected');
  const [agentAddress, setAgentAddress] = useState<string | null>(null);
  const [agentName, setAgentName] = useState('');
  const [request, setRequest] = useState<RuleRequestV1 | null>(null);
  const [paste, setPaste] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<OpenMandateResult | null>(null);
  const amountsReady = Boolean(chain.ready && chain.config);

  function readPaste(text: string): { address: string; request: RuleRequestV1 | null } | null {
    const parsed = parseRuleRequest(text);
    if (parsed.ok) {
      return { address: parsed.request.agent, request: parsed.request };
    }
    const address = canonicalAddress(text.trim());
    if (!address) {
      return null;
    }
    return { address, request: null };
  }

  async function rememberName(address: string) {
    const trimmed = agentName.trim();
    if (!trimmed) {
      return;
    }
    try {
      const book = await loadAddressBook(secureStore);
      await saveAddressBook(secureStore, withSavedName(book, address, trimmed));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The name could not be saved.');
    }
  }

  async function createTestAgent() {
    setBusy(true);
    setError(null);
    try {
      const key = await wallet.createAgentKeypair();
      setRequest(null);
      setAgentAddress(key.publicKey.toBase58());
      setStage('name');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The test agent could not be created.');
    } finally {
      setBusy(false);
    }
  }

  function review() {
    let address = agentAddress;
    let nextRequest = request;
    if (!address) {
      const parsed = readPaste(paste);
      if (!parsed) {
        setError('That is not an agent address or a rule request.');
        return;
      }
      address = parsed.address;
      nextRequest = parsed.request;
      setAgentAddress(address);
      setRequest(nextRequest);
    }
    setError(null);
    void rememberName(address);
    setStage('approve');
  }

  if (stage === 'connected') {
    return (
      <WalletConnectedScreen
        cluster={wallet.cluster}
        owner={wallet.ownerPublicKey}
        error={wallet.error}
        onAddAgent={() => setStage('agent')}
      />
    );
  }

  if (stage === 'agent' || stage === 'paste') {
    if (stage === 'paste') {
      return (
        <NameAgentScreen
          cluster={wallet.cluster}
          address={agentAddress}
          name={agentName}
          onName={setAgentName}
          facts={null}
          error={error}
          showPaste
          paste={paste}
          onPaste={setPaste}
          onReview={review}
          onReject={() => {
            setAgentAddress(null);
            setRequest(null);
            setPaste('');
            setError(null);
            setStage('agent');
          }}
          onBack={() => setStage('agent')}
        />
      );
    }
    return (
      <AddAgentScreen
        cluster={wallet.cluster}
        busy={busy}
        error={error}
        onScan={() => router.push('/scan?target=request')}
        onPaste={() => {
          setError(null);
          setStage('paste');
        }}
        onCreateTest={() => {
          void createTestAgent();
        }}
        onHow={() => router.push('/onboarding')}
        onBack={() => setStage('connected')}
      />
    );
  }

  if (stage === 'name') {
    const facts =
      request && amountsReady
        ? factsFromRequest(request, (amount) => formatTokenAmount(amount, chain.decimals, request.mint))
        : null;
    return (
      <NameAgentScreen
        cluster={wallet.cluster}
        address={agentAddress}
        name={agentName}
        onName={setAgentName}
        facts={facts}
        factsPending={Boolean(request) && !amountsReady && !chain.configError}
        error={error ?? (request && chain.configError ? chain.configError : null)}
        onReview={review}
        onReject={() => {
          setAgentAddress(null);
          setRequest(null);
          setStage('agent');
        }}
        onBack={() => setStage('agent')}
      />
    );
  }

  return (
    <Later
      stage={stage}
      cluster={wallet.cluster}
      agentAddress={agentAddress}
      agentName={agentName}
      request={request}
      opened={opened}
      amountsReady={amountsReady}
      decimals={chain.decimals}
      explorerCluster={chain.config?.explorerCluster ?? wallet.cluster}
      rpcUrl={chain.config?.rpcUrl ?? null}
      onStage={setStage}
      onOpened={setOpened}
      onFinish={() => {
        onFinish();
        router.push('/first-run/protect');
      }}
    />
  );
}

function Later(props: {
  stage: Stage;
  cluster: string | null;
  agentAddress: string | null;
  agentName: string;
  request: RuleRequestV1 | null;
  opened: OpenMandateResult | null;
  amountsReady: boolean;
  decimals: number;
  explorerCluster: string | null;
  rpcUrl: string | null;
  onStage: (stage: Stage) => void;
  onOpened: (result: OpenMandateResult) => void;
  onFinish: () => void;
}) {
  const [View, setView] = useState<ComponentType<typeof props> | null>(null);
  useEffect(() => {
    let alive = true;
    void import('./LaterStages').then((mod) => {
      if (alive) {
        setView(() => mod.LaterStages);
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!View) {
    return <ActivityIndicator color={colors.text} accessibilityLabel="Loading" />;
  }
  return <View {...props} />;
}
