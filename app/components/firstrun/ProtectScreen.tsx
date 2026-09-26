import { GUARDIAN_RECOVERY_COPY, SAFE_WALLET_GUIDANCE, OWNER_SAFE_WARNING } from '../../lib/holdSafeAddress';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { canonicalAddress } from '../../lib/ruleRequest';
import { HoldInput } from '../hold/chrome';
import { type as typeScale } from '../theme';
import { BrassButton, FirstRunChrome, QuietButton } from './Chrome';

export function ProtectScreen({
  cluster,
  owner,
  error,
  initialAddress = '',
  onSeeker,
  onPhone,
  onLater,
}: {
  cluster: string | null;
  owner: string;
  error: string | null;
  initialAddress?: string;
  onSeeker: (address: string) => void;
  onPhone: () => void;
  onLater: () => void;
}) {
  const [choosing, setChoosing] = useState(initialAddress.trim().length > 0);
  const [address, setAddress] = useState(initialAddress);
  const [invalid, setInvalid] = useState<string | null>(null);
  return (
    <FirstRunChrome
      stage="protect"
      cluster={cluster}
      error={invalid ?? error}
      footer={
        <>
          <BrassButton
            label={choosing ? 'Continue with this address' : 'Set up with my second Seeker'}
            onPress={() => {
              if (!choosing) {
                setChoosing(true);
                return;
              }
              const key = canonicalAddress(address.trim());
              if (!key || key === owner || key === '11111111111111111111111111111111') {
                setInvalid(
                  "Paste a valid address from your other phone. It must be different from this phone's wallet address.",
                );
                return;
              }
              onSeeker(key);
            }}
          />
          <QuietButton label="Use a second key on this phone" onPress={onPhone} />
          <QuietButton label="Set up later" onPress={onLater} />
        </>
      }
    >
      <Text style={styles.title}>Protect the rest of your money</Text>
      <Text style={styles.body}>
        With Hold, big withdrawals wait 1, 2 or 3 days. A second key can stop withdrawals or recover the balance.
      </Text>
      <Text style={styles.body}>
        Recommended: use your second Seeker. {GUARDIAN_RECOVERY_COPY} {SAFE_WALLET_GUIDANCE}
      </Text>
      {choosing ? (
        <HoldInput
          label="Second Seeker address"
          value={address}
          onChangeText={(value) => {
            setAddress(value);
            setInvalid(null);
          }}
          hint="On your second Seeker, open your wallet, choose the account you want as your second key, tap Receive for Solana and copy its public address. Paste that address here, never a recovery phrase. You will enter a separate safe wallet address during Hold setup."
        />
      ) : null}
      <Text style={styles.body}>
        A second key on this phone is weaker: if you lose this phone, or someone gets into it, both
        keys are at risk.
      </Text>
      <Text style={styles.body}>{OWNER_SAFE_WARNING}</Text>
      <Text style={styles.body}>You can set up Hold later from Overview.</Text>
    </FirstRunChrome>
  );
}
const styles = StyleSheet.create({
  title: { ...typeScale.body, fontSize: 30, lineHeight: 36 },
  body: typeScale.body,
});
