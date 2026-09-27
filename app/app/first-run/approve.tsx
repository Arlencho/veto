import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { ApprovalScreen } from '../../components/ApprovalScreen';
import { canonicalAddress, parseRuleRequest } from '../../lib/ruleRequest';

export default function ApproveRoute() {
  const params = useLocalSearchParams();
  const parsed = useMemo(() => {
    const raw = params.url;
    const url = Array.isArray(raw) ? raw[0] : raw;
    if (typeof url === 'string' && url.length > 0) {
      return parseRuleRequest(url);
    }
    return null;
  }, [params.url]);
  const rawAgent = Array.isArray(params.agent) ? params.agent[0] : params.agent;
  const agent = typeof rawAgent === 'string' ? canonicalAddress(rawAgent) ?? undefined : undefined;

  if (parsed && !parsed.ok) {
    return <ApprovalScreen mode="request" request={null} invalidReason={parsed.reason} firstRun />;
  }
  if (parsed?.ok) {
    return <ApprovalScreen mode="request" request={parsed.request} invalidReason={null} firstRun />;
  }
  return <ApprovalScreen mode="template" request={null} invalidReason={null} initialAgent={agent} firstRun />;
}
