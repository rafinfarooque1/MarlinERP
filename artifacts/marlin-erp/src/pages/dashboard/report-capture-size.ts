type ReportCaptureDimensions = {
  width: number;
  height: number;
};

export function measureReportCaptureDimensions(target: HTMLElement): ReportCaptureDimensions {
  const card = target.querySelector<HTMLElement>('[data-report-card]');
  if (!card) {
    throw new Error('Report capture card not found');
  }

  const targetRect = target.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const tables = Array.from(target.querySelectorAll<HTMLTableElement>('table'));
  const tableRightEdges = tables.map((table) => table.getBoundingClientRect().right - targetRect.left);
  const tableBottomEdges = tables.flatMap((table) => {
    const tableRect = table.getBoundingClientRect();
    const lastRow = table.rows.item(table.rows.length - 1);
    const lastRowBottom = lastRow
      ? lastRow.getBoundingClientRect().bottom - targetRect.top
      : 0;
    return [tableRect.bottom - targetRect.top, lastRowBottom];
  });

  return {
    width: Math.ceil(Math.max(
      target.scrollWidth,
      targetRect.width,
      card.scrollWidth,
      cardRect.width,
      ...tableRightEdges,
      1,
    )),
    height: Math.ceil(Math.max(
      target.scrollHeight,
      targetRect.height,
      card.scrollHeight,
      cardRect.bottom - targetRect.top,
      ...tableBottomEdges,
      1,
    )) + 2,
  };
}
