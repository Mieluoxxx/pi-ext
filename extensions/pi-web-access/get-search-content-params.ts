export interface GetSearchContentParams {
	responseId: string;
	contentIndex?: number;
	offset?: number;
	limit?: number;
}

export interface LegacyGetSearchContentParams extends GetSearchContentParams {
	query?: string;
	queryIndex?: number;
	url?: string;
	urlIndex?: number;
	findText?: string | string[];
	findMode?: string;
}

export function normalizeGetSearchContentParams(params: LegacyGetSearchContentParams): LegacyGetSearchContentParams {
	// Tool bridges may serialize optional selectors and slice defaults even when unset.
	const normalized = { ...params };

	if (normalized.query?.trim() === "") delete normalized.query;
	if (normalized.url?.trim() === "") delete normalized.url;

	if (normalized.findText !== undefined) {
		delete normalized.offset;
		delete normalized.limit;
	}

	return normalized;
}
