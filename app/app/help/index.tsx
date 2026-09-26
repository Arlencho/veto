import { GUARDIAN_RECOVERY_COPY, SAFE_WALLET_GUIDANCE, OWNER_SAFE_REASON } from '../../lib/holdSafeAddress';
import { usePathname, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { BrassWell, Glow, Rise, ScreenHeader, TopicRow } from '../../components/records/chrome';
import { networkFoot } from '../../components/records/copy';
import { Screen } from '../../components/Screen';
import { colors, fonts } from '../../components/theme';
import { openHelpRefusal } from '../../lib/helpNavigation';
import { PAYEE_NOT_IN_RULESET, PAYEE_PREFILL, RULESET_ENVELOPE } from '../../lib/ruleset';

export default function HelpRuleScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const cluster = process.env.EXPO_PUBLIC_VETO_EXPLORER_CLUSTER;
  return (
    <Screen>
      <Glow />
      <ScreenHeader
        title="Help"
        cluster={cluster}
        onBack={() => router.back()}
      />
      <Rise delayMs={80}>
        <BrassWell lamps>
          <Text style={styles.h1}>Your agent can only ask.</Text>
          <Text style={styles.lead}>
            You set one rule. The Veto program on Solana checks every request against it and pays or
            refuses. Your agent never holds your money.
          </Text>
        </BrassWell>
      </Rise>
      <Text style={styles.body}>Hold recovery: {GUARDIAN_RECOVERY_COPY} {SAFE_WALLET_GUIDANCE} {OWNER_SAFE_REASON}</Text>
      <View style={styles.list}>
        <TopicRow
          tone="brass"
          glyph="◆"
          title="What a rule is"
          body="Who your agent may pay, the most per payment, the total it may ever spend, and when it ends. The money sits in an account only this rule uses."
        />
        <TopicRow
          tone="refused"
          glyph="×"
          title="What a refusal is"
          body="Your agent asked for something the rule does not allow, so the program said no. No money moves. The reason and time are saved on the blockchain."
          onPress={() => openHelpRefusal(router, pathname)}
        />
        <TopicRow
          tone="paid"
          glyph="≡"
          title="What the export proves"
          body="The file lists every payment and refusal under a rule. Anyone can check each line against the blockchain."
          onPress={() => router.push('/help/export')}
        />
        <TopicRow
          tone="bone"
          glyph="↺"
          title="Show the introduction again"
          body="The short tour you saw at the start."
          accessibilityLabel="Show the introduction"
          onPress={() => router.push('/onboarding')}
        />
      </View>
      <Text style={styles.body}>
        A rule is a spending limit you write in advance: how much in total, how much per payment,
        until when, and to which payee. The program on Solana enforces it. An agent can then pay
        inside that rule with nobody present.
      </Text>
      <Text style={styles.body}>
        The numbers are fixed once the rule is opened. They cannot be edited afterwards. An override
        does not change those numbers. It allows one payment, used once, never above the remaining cap.
        Revoke ends authority for the agent. It does not move anything already paid, and the
        decisions stay readable.
      </Text>
      <Text style={styles.body}>
        One owner can hold several rules at once. Each rule has its own agent key, its own limits,
        and its own decision history. A rule opened from this app keeps its budget in its own token
        account, so another rule on the same mint keeps its own delegate. Switching a rule changes
        what Overview and Decisions are about.
      </Text>
      <Text style={styles.body}>
        {`${RULESET_ENVELOPE} ${PAYEE_NOT_IN_RULESET} ${PAYEE_PREFILL} A rule you open still names a payee, because the program enforces it.`}
      </Text>
      <Rise delayMs={240}>
        <TopicRow
          tone="brass"
          glyph="›"
          title="Next"
          body="What a refusal is, then what the export proves."
          accessibilityLabel="Next"
          onPress={() => openHelpRefusal(router, pathname)}
        />
      </Rise>
      <Text style={styles.foot}>{networkFoot()}</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  h1: {
    fontFamily: fonts.serif,
    fontSize: 30,
    lineHeight: 34,
    color: colors.bone,
  },
  lead: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 21,
    color: colors.body,
  },
  list: {
    gap: 10,
  },
  body: {
    color: colors.body,
    fontFamily: fonts.sans,
    fontSize: 16,
    lineHeight: 24,
  },
  foot: {
    textAlign: 'center',
    color: colors.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: 8,
  },
});
