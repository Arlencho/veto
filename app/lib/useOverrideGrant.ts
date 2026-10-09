import { redactRpc } from './rpcPrivacy';
import { useCallback, useEffect, useState } from 'react';

import { KIND_REFUSED } from './constants';
import type { MandateAccount } from './mandate';
import {
  overrideOfferForReason,
  overrideProbeIsCurrent,
  overrideProbeKey,
  overrideRowProbeKey,
  type OverrideAssessment,
} from './override';
import type { LedgerRow } from './ring';

export type OverrideGrantView = {
  assessment: OverrideAssessment | { status: 'checking' } | null;
  confirming: boolean;
  signing: boolean;
  error: string | null;
  confirmed: LedgerRow | null;
  onOffer: () => void;
  onCancel: () => void;
  onSign: () => void;
};

export function useOverrideGrant(args: {
  row: LedgerRow | null | undefined;
  mandate: MandateAccount | null | undefined;
  nowSec: bigint;
  probeOverride: (mandateAddress: string, row: LedgerRow) => Promise<OverrideAssessment>;
  grantOverride: (mandateAddress: string, row: LedgerRow) => Promise<{ row: LedgerRow }>;
}): OverrideGrantView {
  const { row, mandate, nowSec, probeOverride, grantOverride } = args;
  const offer =
    row && row.kind === KIND_REFUSED
      ? overrideOfferForReason(row.reason, row.suggestedOverride)
      : null;
  const needsProbe = Boolean(row && mandate && offer?.offer);
  const rowKey = row ? overrideRowProbeKey(row) : '';
  const key = row && mandate ? overrideProbeKey(row, mandate, nowSec) : '';

  const [probed, setProbed] = useState<{ key: string; assessment: OverrideAssessment } | null>(
    null,
  );
  const [failedRead, setFailedRead] = useState<OverrideAssessment | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ key: string; row: LedgerRow } | null>(null);

  useEffect(() => {
    if (!row || !mandate || !offer?.offer) {
      return;
    }
    // Same row and mandate fields (not object identity): skip the extra chain read.
    // Only a result is cached under the live key. A failure must not skip the retry.
    if (overrideProbeIsCurrent(probed?.key, key)) {
      return;
    }
    let cancelled = false;
    void probeOverride(mandate.address, row)
      .then((next) => {
        if (!cancelled) {
          setProbed({ key, assessment: next });
          setFailedRead(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailedRead({
            status: 'blocked',
            why: 'The chain could not be re-read for this rule. This screen will not offer a one-time allowance from a stale row. Pull to retry.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, mandate, offer?.offer, probeOverride, probed?.key, row]);

  const onOffer = useCallback(() => {
    setError(null);
    setConfirmKey(rowKey);
  }, [rowKey]);

  const onCancel = useCallback(() => {
    setConfirmKey(null);
    setError(null);
  }, []);

  const onSign = useCallback(() => {
    if (!row || !mandate) {
      return;
    }
    setError(null);
    setSigning(true);
    void grantOverride(mandate.address, row)
      .then((result) => {
        setConfirmed({ key: rowKey, row: result.row });
        setConfirmKey(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? redactRpc(err.message) : 'Could not allow this payment once');
      })
      .finally(() => {
        setSigning(false);
      });
  }, [grantOverride, mandate, row, rowKey]);

  let assessment: OverrideAssessment | { status: 'checking' } | null = null;
  if (row && row.kind === KIND_REFUSED) {
    if (offer && !offer.offer) {
      assessment = { status: 'none', why: offer.why };
    } else if (probed && overrideProbeIsCurrent(probed.key, key)) {
      assessment = probed.assessment;
    } else if (failedRead) {
      assessment = failedRead;
    } else if (needsProbe) {
      assessment = { status: 'checking' };
    }
  }

  return {
    assessment,
    confirming: confirmKey === rowKey,
    signing,
    error,
    confirmed: confirmed?.key === rowKey ? confirmed.row : null,
    onOffer,
    onCancel,
    onSign,
  };
}
