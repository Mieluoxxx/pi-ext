import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { renderEditDiffResult } from "./diff-renderer.js";
import { extractTextOutput, pluralize, shortenPath } from "./render-utils.js";
import { toRecord } from "./tool-metadata.js";
import type { ToolDisplayConfig } from "./types.js";

type ApplyPatchOperation = "add" | "delete" | "update";

interface ApplyPatchRenderTheme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold(text: string): string;
	getFgAnsi?(color: string): string;
	getBgAnsi?(color: string): string;
}

interface ApplyPatchRenderContext {
	args?: unknown;
	cwd?: string;
	argsComplete?: boolean;
	isError?: boolean;
}

interface ApplyPatchToolResult {
	content?: unknown;
	details?: unknown;
	isError?: boolean;
}

interface ApplyPatchTarget {
	filePath: string;
	movePath?: string;
	operation: ApplyPatchOperation;
}

interface ApplyPatchPreviewFile extends ApplyPatchTarget {
	diff: string;
	added: number;
	removed: number;
}

interface ApplyPatchPreview {
	files: ApplyPatchPreviewFile[];
	added: number;
	removed: number;
}

interface ApplyPatchProgress {
	applied: number;
	failed: number;
	total: number;
}

interface ApplyPatchFailure {
	filePath: string;
	message?: string;
}

interface ApplyPatchExecutionResult {
	appliedFiles: string[];
	failures: ApplyPatchFailure[];
	hasPartialSuccess: boolean;
}

interface ApplyPatchDetails {
	preview?: ApplyPatchPreview;
	progress?: ApplyPatchProgress;
	result?: ApplyPatchExecutionResult;
}

const PATCH_FILE_HEADER_PATTERN = /^\*\*\* (Add|Delete|Update) File: (.+)$/;
const PATCH_MOVE_HEADER_PATTERN = /^\*\*\* Move to: (.+)$/;

function getStringField(value: unknown, field: string): string | undefined {
	const raw = toRecord(value)[field];
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function getNonNegativeNumber(value: unknown, field: string): number | undefined {
	const raw = toRecord(value)[field];
	return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function getBooleanField(value: unknown, field: string): boolean | undefined {
	const raw = toRecord(value)[field];
	return typeof raw === "boolean" ? raw : undefined;
}

function getPatchInput(args: unknown): string {
	if (typeof args === "string") {
		return args;
	}
	return getStringField(args, "input") ?? "";
}

function toApplyPatchOperation(value: unknown): ApplyPatchOperation | undefined {
	return value === "add" || value === "delete" || value === "update" ? value : undefined;
}

function operationFromHeader(value: string): ApplyPatchOperation {
	if (value === "Add") {
		return "add";
	}
	if (value === "Delete") {
		return "delete";
	}
	return "update";
}

export function extractApplyPatchTargets(args: unknown): ApplyPatchTarget[] {
	const targets: ApplyPatchTarget[] = [];
	for (const line of getPatchInput(args).replace(/\r/g, "").split("\n")) {
		const fileMatch = line.match(PATCH_FILE_HEADER_PATTERN);
		if (fileMatch) {
			const operationHeader = fileMatch[1];
			const filePath = fileMatch[2]?.trim();
			if (operationHeader && filePath) {
				targets.push({ filePath, operation: operationFromHeader(operationHeader) });
			}
			continue;
		}

		const moveMatch = line.match(PATCH_MOVE_HEADER_PATTERN);
		const movePath = moveMatch?.[1]?.trim();
		const currentTarget = targets.at(-1);
		if (movePath && currentTarget?.operation === "update") {
			currentTarget.movePath = movePath;
		}
	}
	return targets;
}

function parsePreviewFile(value: unknown): ApplyPatchPreviewFile | undefined {
	const record = toRecord(value);
	const filePath = getStringField(record, "filePath");
	const operation = toApplyPatchOperation(record.operation);
	const diff = typeof record.diff === "string" ? record.diff : undefined;
	if (!filePath || !operation || diff === undefined) {
		return undefined;
	}

	const file: ApplyPatchPreviewFile = {
		filePath,
		operation,
		diff,
		added: getNonNegativeNumber(record, "added") ?? 0,
		removed: getNonNegativeNumber(record, "removed") ?? 0,
	};
	const movePath = getStringField(record, "movePath");
	return movePath ? { ...file, movePath } : file;
}

function parsePreview(value: unknown): ApplyPatchPreview | undefined {
	const record = toRecord(value);
	if (!Array.isArray(record.files)) {
		return undefined;
	}
	const parsedFiles = record.files.map(parsePreviewFile);
	if (parsedFiles.length === 0 || parsedFiles.some((file) => file === undefined)) {
		return undefined;
	}
	const files = parsedFiles as ApplyPatchPreviewFile[];
	return {
		files,
		added: getNonNegativeNumber(record, "added") ?? files.reduce((sum, file) => sum + file.added, 0),
		removed: getNonNegativeNumber(record, "removed") ?? files.reduce((sum, file) => sum + file.removed, 0),
	};
}

function parseProgress(value: unknown): ApplyPatchProgress | undefined {
	const applied = getNonNegativeNumber(value, "applied");
	const failed = getNonNegativeNumber(value, "failed");
	const total = getNonNegativeNumber(value, "total");
	return applied === undefined || failed === undefined || total === undefined
		? undefined
		: { applied, failed, total };
}

function parseFailure(value: unknown): ApplyPatchFailure | undefined {
	const filePath = getStringField(value, "filePath");
	if (!filePath) {
		return undefined;
	}
	const message = getStringField(value, "message");
	return message ? { filePath, message } : { filePath };
}

function parseExecutionResult(value: unknown): ApplyPatchExecutionResult | undefined {
	const record = toRecord(value);
	if (!Array.isArray(record.failures)) {
		return undefined;
	}
	const failures = record.failures.map(parseFailure).filter((failure): failure is ApplyPatchFailure => failure !== undefined);
	const appliedFiles = Array.isArray(record.appliedFiles)
		? record.appliedFiles.filter((filePath): filePath is string => typeof filePath === "string" && filePath.length > 0)
		: [];
	return {
		appliedFiles,
		failures,
		hasPartialSuccess: getBooleanField(record, "hasPartialSuccess") ?? (appliedFiles.length > 0 && failures.length > 0),
	};
}

function parseApplyPatchDetails(value: unknown): ApplyPatchDetails {
	const record = toRecord(value);
	return {
		preview: parsePreview(record.preview),
		progress: parseProgress(record.progress),
		result: parseExecutionResult(record.result),
	};
}

function normalizePathSeparators(filePath: string): string {
	return filePath.replaceAll(sep, "/");
}

function displayPath(filePath: string, cwd: string): string {
	if (!isAbsolute(filePath)) {
		return normalizePathSeparators(filePath);
	}

	const relativePath = relative(resolve(cwd), filePath);
	if (
		relativePath === ""
		|| (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	) {
		return normalizePathSeparators(relativePath || ".");
	}
	return normalizePathSeparators(shortenPath(filePath));
}

function formatTargetPath(target: Pick<ApplyPatchTarget, "filePath" | "movePath">, cwd: string): string {
	const filePath = displayPath(target.filePath, cwd);
	return target.movePath ? `${filePath} -> ${displayPath(target.movePath, cwd)}` : filePath;
}

function formatOperationLabel(operation: ApplyPatchOperation): string {
	if (operation === "add") {
		return "add";
	}
	if (operation === "delete") {
		return "delete";
	}
	return "edit";
}

function createPerFileConfig(config: ToolDisplayConfig, fileCount: number): ToolDisplayConfig {
	if (fileCount <= 1) {
		return config;
	}
	return {
		...config,
		diffCollapsedLines: Math.max(1, Math.floor(config.diffCollapsedLines / fileCount)),
		expandedPreviewMaxLines: Math.max(1, Math.floor(config.expandedPreviewMaxLines / fileCount)),
	};
}

function renderFileHeader(
	file: ApplyPatchPreviewFile,
	cwd: string,
	failed: boolean,
	theme: ApplyPatchRenderTheme,
): Text {
	const label = failed ? "failed" : formatOperationLabel(file.operation);
	const labelColor = failed ? "error" : "toolTitle";
	return new Text(
		`${theme.fg(labelColor, theme.bold(label))} ${theme.fg("accent", formatTargetPath(file, cwd))}`,
		0,
		0,
	);
}

function renderFailureStatus(result: ApplyPatchExecutionResult, theme: ApplyPatchRenderTheme): Text | undefined {
	if (result.failures.length === 0) {
		return undefined;
	}
	const status = result.hasPartialSuccess || result.appliedFiles.length > 0
		? `patch partially applied (${result.appliedFiles.length} applied, ${result.failures.length} failed) • preview includes intended changes`
		: `patch failed (${result.failures.length} ${pluralize(result.failures.length, "file")}) • preview shows intended changes`;
	return new Text(theme.fg("error", `↳ ${status}`), 0, 0);
}

function renderProgressStatus(progress: ApplyPatchProgress, theme: ApplyPatchRenderTheme): Text {
	const completed = Math.min(progress.total, progress.applied + progress.failed);
	return new Text(theme.fg("muted", `↳ applying patch ${completed}/${progress.total}`), 0, 0);
}

export function renderApplyPatchCall(
	args: unknown,
	theme: ApplyPatchRenderTheme,
	context?: ApplyPatchRenderContext,
): Text {
	const targets = extractApplyPatchTargets(args);
	const cwd = context?.cwd ?? process.cwd();
	const targetLabel = targets.length === 1
		? formatTargetPath(targets[0]!, cwd)
		: targets.length > 1
			? `${targets.length} files`
			: "...";
	return new Text(
		`${theme.fg("toolTitle", theme.bold("apply_patch"))} ${theme.fg("accent", targetLabel)}`,
		0,
		0,
	);
}

export function renderApplyPatchResult(
	result: ApplyPatchToolResult,
	options: ToolRenderResultOptions,
	config: ToolDisplayConfig,
	theme: ApplyPatchRenderTheme,
	context?: ApplyPatchRenderContext,
): Component {
	const fallbackText = extractTextOutput(result);
	const details = parseApplyPatchDetails(result.details);
	const preview = details.preview;
	const isError = context?.isError === true || result.isError === true;

	if (!preview) {
		if (options.isPartial) {
			return details.progress
				? renderProgressStatus(details.progress, theme)
				: new Text(theme.fg("muted", "↳ applying patch..."), 0, 0);
		}
		if (isError) {
			return new Text(theme.fg("error", fallbackText || "apply_patch failed"), 0, 0);
		}
		return new Text(theme.fg("toolOutput", fallbackText || "↳ patch completed (no diff payload)"), 0, 0);
	}

	const component = new Container();
	const failureStatus = details.result ? renderFailureStatus(details.result, theme) : undefined;
	const errorStatus = failureStatus ?? (isError
		? new Text(theme.fg("error", "↳ apply_patch failed • preview shows intended changes"), 0, 0)
		: undefined);
	if (errorStatus) {
		component.addChild(errorStatus);
		if (options.expanded && fallbackText) {
			component.addChild(new Text(theme.fg("error", fallbackText), 0, 0));
		}
	} else if (options.isPartial && details.progress) {
		component.addChild(renderProgressStatus(details.progress, theme));
	}

	const failedPaths = new Set(details.result?.failures.map((failure) => failure.filePath) ?? []);
	const perFileConfig = createPerFileConfig(config, preview.files.length);
	const showFileHeaders = preview.files.length > 1 || failedPaths.size > 0;

	for (let index = 0; index < preview.files.length; index++) {
		const file = preview.files[index]!;
		if (index > 0 || errorStatus || (options.isPartial && details.progress)) {
			component.addChild(new Spacer(1));
		}
		if (showFileHeaders) {
			component.addChild(renderFileHeader(file, context?.cwd ?? process.cwd(), failedPaths.has(file.filePath), theme));
		}
		component.addChild(renderEditDiffResult(
			{ diff: file.diff },
			{
				expanded: options.expanded === true,
				filePath: file.movePath ?? file.filePath,
			},
			perFileConfig,
			theme,
			file.diff.trim() ? "" : `↳ ${formatOperationLabel(file.operation)} completed (no diff payload)`,
		));
	}

	return component;
}
