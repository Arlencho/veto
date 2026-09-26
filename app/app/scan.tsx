import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ProgressStrip } from '../components/backglass/ProgressStrip';
import { ClusterPill } from '../components/daily/ClusterPill';
import { ScanFrame } from '../components/daily/ScanFrame';
import { Field } from '../components/Field';
import { RuleScreen } from '../components/RuleScreen';
import { TopBar } from '../components/TopBar';
import { colors, fonts, radii, space } from '../components/theme';
import { canonicalAddress, readScannedText, ruleRequestHref } from '../lib/ruleRequest';
import { stageAddressScan, stageWriteRule, type AddressScanTarget } from '../lib/scanHandoff';
import { useWallet } from '../lib/useWallet';

export default function ScanScreen() {
  const params = useLocalSearchParams<{ target?: string }>();
  const router = useRouter();
  const wallet = useWallet();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [torch, setTorch] = useState(false);
  const handled = useRef(false);
  const target: AddressScanTarget | 'request' =
    params.target === 'agent' || params.target === 'payee' ? params.target : 'request';
  const cluster = wallet.cluster ?? undefined;
  const requestScan = target === 'request';

  function returnAddress(field: AddressScanTarget, address: string) {
    // Resume the existing draft, including its agent and first-run state.
    // A single address is a field edit, never a rule request.
    stageAddressScan(field, address);
    router.back();
  }

  const fallback = target === 'payee' ? (
    <View style={styles.paste}>
      <Field
        label="Payee address"
        value={paste}
        onChangeText={(text) => {
          setPaste(text);
          setPasteError(null);
        }}
        placeholder="Paste the payee address"
      />
      {pasteError ? <Text accessibilityRole="alert" style={styles.error}>{pasteError}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Use payee address"
        style={styles.ghost}
        onPress={() => {
          if (handled.current) return;
          const address = canonicalAddress(paste.trim());
          if (!address) {
            setPasteError('Enter a valid payee address.');
            return;
          }
          handled.current = true;
          returnAddress('payee', address);
        }}
      >
        <Text style={styles.ghostText}>Use payee address</Text>
      </Pressable>
    </View>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="No code? Write the rule yourself"
      onPress={() => router.push('/rule/new')}
      style={styles.ghost}
    >
      <Text style={styles.ghostText}>No code? Write the rule yourself</Text>
    </Pressable>
  );

  if (!permission) {
    return (
      <RuleScreen>
        <TopBar
          back="Close"
          center="Scan a code"
          accessory={cluster ? <ClusterPill cluster={cluster} /> : null}
        />
        <Text style={styles.body}>Checking the camera.</Text>
        {target === 'payee' ? fallback : null}
      </RuleScreen>
    );
  }

  if (!permission.granted) {
    return (
      <RuleScreen>
        <TopBar
          back="Close"
          center="Scan a code"
          accessory={cluster ? <ClusterPill cluster={cluster} /> : null}
        />
        {requestScan ? <ProgressStrip current="agent" done={['learn', 'connect']} /> : null}
        <View style={styles.denied}>
          <View style={styles.deniedCopy}>
            <Text style={styles.deniedTitle}>The camera is off</Text>
            <Text style={styles.hint}>
              {permission.canAskAgain
                ? 'Veto needs it to read the code. Nothing is saved from the camera.'
                : 'Turn it on in system settings, then come back. Nothing is saved from the camera.'}
            </Text>
          </View>
          {permission.canAskAgain ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Allow camera"
              onPress={() => {
                void requestPermission();
              }}
              style={styles.allow}
            >
              <Text style={styles.allowText}>Allow camera</Text>
            </Pressable>
          ) : null}
        </View>
        {fallback}
      </RuleScreen>
    );
  }

  return (
    <RuleScreen>
      <View style={styles.header}>
        <TopBar
          back="Close"
          center="Scan a code"
          accessory={cluster ? <ClusterPill cluster={cluster} /> : null}
        />
        {requestScan ? <ProgressStrip current="agent" done={['learn', 'connect']} /> : null}
        <ScanFrame caption={error ? 'That code did not read' : 'Looking for the code'}>
          <CameraView
            style={styles.camera}
            facing="back"
            enableTorch={torch}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={(result) => {
              if (handled.current) {
                return;
              }
              handled.current = true;
              const read = readScannedText(result.data);
              if (read.kind === 'request' && target !== 'payee') {
                const href = ruleRequestHref(read.url);
                if (href) {
                  router.replace(href as Href);
                  return;
                }
              }
              if (read.kind === 'address') {
                if (target === 'request') {
                  stageWriteRule(read.address);
                  router.replace('/rule/new' as Href);
                  return;
                }
                returnAddress(target, read.address);
                return;
              }
              setError(
                read.kind === 'invalid'
                  ? read.reason
                  : target === 'request'
                    ? 'That code is not a rule request.'
                    : 'That code is not an address.',
              );
              handled.current = false;
            }}
          />
        </ScanFrame>
        <View style={styles.holdRow}>
          <Text style={styles.hint}>Hold the code inside the marks</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={torch ? 'Turn off the light' : 'Turn on the light'}
            onPress={() => setTorch((on) => !on)}
            style={styles.light}
          >
            <Text style={styles.lightText}>{torch ? 'Light on' : 'Light'}</Text>
          </Pressable>
        </View>
        <Text style={styles.title}>
          {target === 'payee'
            ? 'Point the camera at the payee address code.'
            : "Point the camera at your agent's rule request code."}
        </Text>
        <Text style={styles.body}>
          {target === 'payee'
            ? 'Scan the payee address or paste it below to return to your rule.'
            : 'Your agent shows the code where it runs. It holds the rule your agent asks for. You still check and approve it on the next screen.'}
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {fallback}
        <Text style={styles.footer}>
          Scanning moves no money. You approve the rule yourself, in Seed Vault.
        </Text>
      </View>
    </RuleScreen>
  );
}

const styles = StyleSheet.create({
  paste: {
    gap: space.md,
  },
  header: {
    paddingTop: space.xxxl,
    gap: space.xl,
  },
  body: {
    color: colors.body,
    fontSize: 14,
    lineHeight: 21,
    fontFamily: fonts.sans,
  },
  title: {
    fontFamily: fonts.serifRegular,
    fontSize: 30,
    lineHeight: 34,
    color: colors.bone,
  },
  hint: {
    flex: 1,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: fonts.sans,
  },
  error: {
    color: colors.refused,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: fonts.sans,
  },
  camera: {
    ...StyleSheet.absoluteFill,
  },
  holdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  light: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lightText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.brass,
  },
  denied: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xl,
    padding: space.xl,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: 'rgba(228, 164, 142, 0.45)',
  },
  deniedCopy: {
    flex: 1,
    gap: 2,
  },
  deniedTitle: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.bone,
  },
  allow: {
    minHeight: 44,
    paddingHorizontal: space.xxl,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: 'rgba(201, 162, 77, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  allowText: {
    fontFamily: fonts.sansBold,
    fontSize: 14,
    color: colors.brass,
  },
  ghost: {
    minHeight: 52,
    borderRadius: radii.cta,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  ghostText: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    lineHeight: 20,
    color: colors.bone,
    textAlign: 'center',
  },
  footer: {
    textAlign: 'center',
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
  },
});
