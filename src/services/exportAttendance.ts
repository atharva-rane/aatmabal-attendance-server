import ExcelJS from 'exceljs';
import { buildSheet, type Cell } from './attendanceSheet';

const MAX_SHEET_NAME = 31;

/** Excel sheet names: max 31 chars, no \ / ? * [ ] : and unique (case-insensitive). */
function uniqueSheetName(base: string, used: Set<string>): string {
  const clean =
    base
      .replace(/[\\/?*[\]:]/g, '-')
      .replace(/^'+|'+$/g, '')
      .slice(0, MAX_SHEET_NAME) || 'Sheet';

  let name = clean;
  let counter = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${counter++})`;
    name = clean.slice(0, MAX_SHEET_NAME - suffix.length) + suffix;
  }

  used.add(name.toLowerCase());
  return name;
}

const CELL_TEXT: Record<Cell, string> = { P: 'P', A: 'A', SNA: 'SNA', PENDING: '…', '-': '-' };
const CELL_COLOR: Partial<Record<Cell, string>> = { P: 'FF1E8E5A', A: 'FFC0392B', SNA: 'FF7A7A7A' };

/** One sheet per role: Sr. No. | Name | one column per seva date | Percentage. */
export async function buildAttendanceWorkbook(): Promise<ExcelJS.Workbook> {
  const sheetData = await buildSheet();

  const workbook = new ExcelJS.Workbook();
  const usedNames = new Set<string>();

  for (const role of sheetData) {
    const sheet = workbook.addWorksheet(uniqueSheetName(role.role, usedNames));

    const percentCol = role.dates.length + 3;
    sheet.columns = [
      { header: 'Sr. No.', width: 8 },
      { header: 'Name', width: 28 },
      ...role.dates.map((d) => ({ header: d.label, width: 12 })),
      { header: 'Percentage', width: 12 },
    ];
    sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }];

    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.alignment = { horizontal: 'center' };

    role.sevaks.forEach((sevak, i) => {
      const row = sheet.addRow([i + 1, sevak.name, ...sevak.cells.map((c) => CELL_TEXT[c]), sevak.percentage / 100]);

      sevak.cells.forEach((c, j) => {
        const cell = row.getCell(j + 3);
        cell.alignment = { horizontal: 'center' };
        const color = CELL_COLOR[c];
        if (color) cell.font = { bold: c !== 'SNA', color: { argb: color } };
      });

      const pct = row.getCell(percentCol);
      pct.numFmt = '0%';
      pct.alignment = { horizontal: 'center' };
    });
  }

  if (!sheetData.length) workbook.addWorksheet('Empty');
  return workbook;
}
