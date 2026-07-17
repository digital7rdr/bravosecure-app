import {Injectable} from '@nestjs/common';
import {regionUtcOffsetHours} from '../common/regions';

/**
 * Pricing calculator for Lite bookings.
 *
 * Base rate: 1 CPO + 1 Vehicle + 1 Driver = EUR 86/hr (≈ AED 350/hr).
 * Extra CPOs / vehicles above baseline: +25% of base per additional unit.
 * Driver-only (client vehicle): 0.65× base.
 * Add-ons: per-hour EUR from `lite_booking_add_ons` table (sum).
 * Peak-hour multiplier (17:00–20:00 local): 1.2×.
 * EUR → AED: fixed conversion (350 / 86 ≈ 4.07).
 *
 * EUR is source of truth; AED is display only.
 */

export interface AddOnPricing {
  id: string;
  label: string;
  price_eur_per_hour: number;
}

export interface PricingInput {
  cpoCount: number;
  vehicleCount: number;
  driverOnly: boolean;
  durationHours: number;
  pickupTime: Date;
  addOns: AddOnPricing[];
  /** LM-M2 — region the pickup happens in; drives the LOCAL peak-hour window.
   *  Optional so legacy callers keep compiling (missing region = UTC, the old
   *  behaviour). */
  regionCode?: string;
}

export interface PricingBreakdownLine {
  label: string;
  amount_eur: number;
}

export interface PricingResult {
  rate_eur_per_hour: number;
  rate_aed_per_hour: number;
  total_eur: number;
  total_aed: number;
  breakdown: PricingBreakdownLine[];
}

const BASE_RATE_EUR = 86;
const BASE_RATE_AED = 350;
const EUR_TO_AED = BASE_RATE_AED / BASE_RATE_EUR;

@Injectable()
export class PricingService {
  calculate(input: PricingInput): PricingResult {
    const breakdown: PricingBreakdownLine[] = [];
    let rate = BASE_RATE_EUR;
    breakdown.push({label: 'Base rate (1 CPO · 1 Vehicle · 1 Driver)', amount_eur: BASE_RATE_EUR});

    const extraCpos = Math.max(0, input.cpoCount - 1);
    if (extraCpos > 0) {
      const add = extraCpos * BASE_RATE_EUR * 0.25;
      rate += add;
      breakdown.push({label: `+${extraCpos} CPO`, amount_eur: +add.toFixed(2)});
    }

    const extraVehicles = Math.max(0, input.vehicleCount - 1);
    if (extraVehicles > 0) {
      const add = extraVehicles * BASE_RATE_EUR * 0.25;
      rate += add;
      breakdown.push({label: `+${extraVehicles} Vehicle`, amount_eur: +add.toFixed(2)});
    }

    if (input.driverOnly) {
      const before = rate;
      rate *= 0.65;
      breakdown.push({
        label: 'Driver-only discount (−35%)',
        amount_eur: +(rate - before).toFixed(2),
      });
    }

    for (const a of input.addOns) {
      rate += a.price_eur_per_hour;
      breakdown.push({label: a.label, amount_eur: a.price_eur_per_hour});
    }

    // Peak surcharge — LM-M2: 17:00–20:00 in the REGION's local wall clock (the
    // doc always said "local"; the old getUTCHours() fired the surcharge at the
    // wrong time in every non-UTC region, e.g. 21:00–24:00 Dubai time).
    const hour = (input.pickupTime.getUTCHours() + regionUtcOffsetHours(input.regionCode) + 24) % 24;
    let peakMultiplier = 1;
    if (hour >= 17 && hour < 20) {
      peakMultiplier = 1.2;
      const surcharge = rate * 0.2;
      breakdown.push({label: 'Peak surcharge (17–20)', amount_eur: +surcharge.toFixed(2)});
    }

    const rateEur = +(rate * peakMultiplier).toFixed(2);
    const durationHours = Math.max(1, input.durationHours);
    const totalEur = +(rateEur * durationHours).toFixed(2);

    return {
      rate_eur_per_hour: rateEur,
      rate_aed_per_hour: +(rateEur * EUR_TO_AED).toFixed(2),
      total_eur: totalEur,
      total_aed: +(totalEur * EUR_TO_AED).toFixed(2),
      breakdown,
    };
  }
}
