export const DEFAULT_PAGE_SIZE = 50;

export function paginateItems(items, requestedPage = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const source = Array.isArray(items) ? items : [];
  const normalizedPageSize = Number.isSafeInteger(pageSize) && pageSize > 0
    ? pageSize
    : DEFAULT_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(source.length / normalizedPageSize));
  const page = Math.min(
    totalPages,
    Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1)
  );
  const startIndex = (page - 1) * normalizedPageSize;

  return {
    items: source.slice(startIndex, startIndex + normalizedPageSize),
    page,
    pageSize: normalizedPageSize,
    totalItems: source.length,
    totalPages,
    startIndex,
    endIndex: Math.min(source.length, startIndex + normalizedPageSize)
  };
}
