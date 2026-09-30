const ordinalDay = (n: number): string => {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
};

/** Excel download name with today's date (IST), e.g. "2nd_Oct 2026_Aatmabal_Attendance.xlsx". */
export function attendanceFileName(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][get('month') - 1];
  return `${ordinalDay(get('day'))}_${month} ${get('year')}_Aatmabal_Attendance.xlsx`;
}
