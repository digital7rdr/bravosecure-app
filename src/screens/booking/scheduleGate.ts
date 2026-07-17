// Why: the Schedule step (BookingDateTimeScreen) gates advancing to the next step
// on having the required locations. A point-to-point `transfer` needs BOTH a
// pick-up and a drop-off; hourly/itinerary bookings legitimately have no single
// destination, so they only require a pick-up. Extracted here so the gate is
// unit-testable without rendering the screen.
export const canAdvanceSchedule = (
  type: string | undefined,
  pickup: unknown,
  dropoff: unknown,
): boolean => Boolean(pickup) && (type !== 'transfer' || Boolean(dropoff));
