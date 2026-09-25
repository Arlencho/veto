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
  onSeeker,
  onPhone,
  onLater,
}: {
  cluster: string | null;
  owner: string;
  error: string | null;
  onSeeker: (address: string) => void;
  onPhone: () => void;
  onLater: () => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const [address, setAddress] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  return (
    <FirstRunChrome
      stage="live"
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
                  'Paste a valid address from your other phone, different from your owner key.',
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
        With Hold, big withdrawals wait 1, 2 or 3 days. A second key can only say no.
      </Text>
      <Text style={styles.body}>
        Recommended: use your second Seeker. Its key can stop a waiting withdrawal, freeze the vault
        and move everything to your safe address, and nothing else on its own.
      </Text>
      {choosing ? (
        <HoldInput
          label="Second Seeker address"
          value={address}
          onChangeText={(value) => {
            setAddress(value);
            setInvalid(null);
          }}
          hint="On your second Seeker, open your wallet, choose the account you control, tap Receive for Solana and copy its public address. Paste that address here, never a recovery phrase. This is also your safe address unless you change it in setup."
        />
      ) : null}
      <Text style={styles.body}>
        A guardian on the same phone is weaker: losing that phone or access to it can put both keys
        at risk.
      </Text>
      <Text style={styles.body}>Set up later keeps Hold on Overview whenever you are ready.</Text>
    </FirstRunChrome>
  );
}
const styles = StyleSheet.create({
  title: { ...typeScale.body, fontSize: 30, lineHeight: 36 },
  body: typeScale.body,
});
