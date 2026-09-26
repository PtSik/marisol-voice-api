import { describe, expect, it } from 'bun:test';
import { buildReferralUpdate } from '../../routes/admin/referrals';
import { adminCall as call } from '../helpers';

describe('/admin/referrals', () => {
  it('requires admin auth', async () => {
    const res = await call('/admin/referrals', {}, false);
    expect(res.status).toBe(401);
  });

  it('lets a filtered list through to the DB', async () => {
    const res = await call('/admin/referrals?status=qualified&mature_before=2026-07-23T00:00:00Z');
    expect(res.status).toBe(500);
  });

  it('rejects a create without a referral code', async () => {
    const res = await call('/admin/referrals', {
      method: 'POST',
      body: JSON.stringify({ referred_lead_id: 'lead-1' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('referral_code');
  });

  it('rejects a create without a referred lead id', async () => {
    const res = await call('/admin/referrals', {
      method: 'POST',
      body: JSON.stringify({ referral_code: 'ABCD1234' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('referred_lead_id');
  });

  it('lets a valid create through to the DB', async () => {
    const res = await call('/admin/referrals', {
      method: 'POST',
      body: JSON.stringify({ referral_code: 'ABCD1234', referred_lead_id: 'lead-1' }),
    });
    expect(res.status).toBe(500);
  });

  it('rejects a patch with no updatable fields', async () => {
    const res = await call('/admin/referrals/abc', {
      method: 'PATCH',
      body: JSON.stringify({ amount_cents: 999999, referrer_account_id: 'spoofed' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No updatable fields');
  });

  it('rejects a patch with an unknown status', async () => {
    const res = await call('/admin/referrals/abc', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'refunded' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a patch with an unknown expected_status', async () => {
    const res = await call('/admin/referrals/abc', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'claimable', expected_status: 'nonsense' }),
    });
    expect(res.status).toBe(400);
  });

  it('lets a valid compare-and-set patch through to the DB', async () => {
    const res = await call('/admin/referrals/abc', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'claimable', expected_status: 'qualified' }),
    });
    expect(res.status).toBe(500);
  });

  it('rejects the retired credit statuses', async () => {
    for (const status of ['crediting', 'credited']) {
      const res = await call('/admin/referrals/abc', {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe('buildReferralUpdate', () => {
  it('drops fields outside the whitelist', () => {
    const built = buildReferralUpdate({
      status: 'void',
      amount_cents: 1,
      referrer_account_id: 'spoofed',
    });
    expect(built).toEqual({ update: { status: 'void' } });
  });

  it('keeps expected_status out of the update', () => {
    const built = buildReferralUpdate({ status: 'payout_requested', expected_status: 'claimable' });
    expect(built).toEqual({ update: { status: 'payout_requested' } });
  });

  it('rejects an unknown status', () => {
    expect(buildReferralUpdate({ status: 'refunded' })).toEqual({ error: 'invalid status' });
  });

  it('rejects a body with nothing updatable', () => {
    expect(buildReferralUpdate({ id: 'x' })).toEqual({ error: 'No updatable fields provided' });
  });
});
