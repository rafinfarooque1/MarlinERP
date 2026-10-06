type SquareReportCapture = {
  width: number;
  height: number;
  restore: () => void;
};

export function prepareSquareReportCapture(target: HTMLElement): SquareReportCapture {
  const card = target.querySelector<HTMLElement>('[data-square-report-card]');
  const viewport = target.querySelector<HTMLElement>('[data-square-report-viewport]');
  const content = target.querySelector<HTMLElement>('[data-square-report-content]');

  if (!card || !viewport || !content) {
    throw new Error('Square report capture elements not found');
  }

  const cardRect = card.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  const tables = Array.from(target.querySelectorAll<HTMLTableElement>('table'));
  const tableWidths = tables.map((table) => {
    const rect = table.getBoundingClientRect();
    return Math.max(table.scrollWidth, rect.right - contentRect.left);
  });
  const lastRowBottoms = tables.map((table) => {
    const lastRow = table.rows.item(table.rows.length - 1);
    return lastRow ? lastRow.getBoundingClientRect().bottom - contentRect.top : 0;
  });

  const contentWidth = Math.max(
    content.scrollWidth,
    contentRect.width,
    ...tableWidths,
    1,
  );
  const contentHeight = Math.max(
    content.scrollHeight,
    contentRect.height,
    ...lastRowBottoms,
    1,
  );
  const viewportStyle = getComputedStyle(viewport);
  const horizontalPadding =
    Number.parseFloat(viewportStyle.paddingLeft) + Number.parseFloat(viewportStyle.paddingRight);
  const verticalPadding =
    Number.parseFloat(viewportStyle.paddingTop) + Number.parseFloat(viewportStyle.paddingBottom);
  const availableWidth = viewport.clientWidth - horizontalPadding;
  const availableHeight = viewport.clientHeight - verticalPadding;

  if (availableWidth <= 0 || availableHeight <= 0) {
    throw new Error('Square report capture area has no available space');
  }

  const zoom = Math.min(1, availableWidth / contentWidth, availableHeight / contentHeight);
  const originalZoom = content.style.zoom;
  if (zoom < 1) content.style.zoom = String(zoom);

  const side = Math.ceil(Math.max(cardRect.width, cardRect.height));
  return {
    width: side,
    height: side,
    restore: () => {
      content.style.zoom = originalZoom;
    },
  };
}
