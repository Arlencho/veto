import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, space, touchTarget } from '../theme';

export function HoldEntry({ cluster }: { cluster: string | null | undefined }) {
  const router = useRouter();
  if (cluster !== 'devnet' && cluster !== 'testnet') return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open Hold. Big money waits, and a second key can say no."
      onPress={() => router.push('/hold')}
      style={styles.card}
    >
      <View style={styles.copy}>
        <Text style={styles.kicker}>Hold</Text>
        <Text style={styles.title}>Big money waits, and a second key can say no.</Text>
        <Text style={styles.body}>
          If someone gets your key, a big withdrawal or one to a new address has to wait, and you or your guardian can stop it before it goes through.
        </Text>
      </View>
      <Text style={styles.action}>Open</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: touchTarget,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.brassLine,
    padding: space.xxl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
  },
  copy: {
    flex: 1,
    gap: space.xs,
  },
  kicker: {
    color: colors.brass,
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.bone,
    fontFamily: fonts.serifRegular,
    fontSize: 18,
    lineHeight: 22,
  },
  body: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  action: {
    color: colors.brass,
    fontFamily: fonts.sansBold,
    fontSize: 14,
  },
});
