import path from 'node:path';
import { cwd, env, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

export const FINAL_FAILURE_ANNOTATIONS = fileURLToPath(import.meta.url);

export const GITHUB_TITLE_LIMIT = 255;

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TRUNCATION_MARK = '…';
const NOT_A_VERDICT = new Set(['skipped', 'interrupted']);

interface Location {
  file: string;
  line: number;
  column: number;
}

interface ReportedError {
  message?: string;
  value?: string;
  stack?: string;
  snippet?: string;
  location?: Location;
}

interface Attempt {
  status: string;
  errors: ReportedError[];
}

interface Case {
  id: string;
  location: Location;
  retries: number;
  expectedStatus: string;
  tags: string[];
  results: Attempt[];
  outcome(): 'skipped' | 'expected' | 'unexpected' | 'flaky';
  titlePath(): string[];
}

interface Run {
  allTests(): Case[];
}

interface RunConfig {
  tags: string[];
}

interface RunResult {
  status: 'passed' | 'failed' | 'timedout' | 'interrupted';
}

interface PathApi {
  sep: string;
  relative(from: string, to: string): string;
}

export interface SourceRoots {
  okRoot: string;
  workspace: string;
  override: string | undefined;
  pathApi: PathApi;
}

const data = (text: string) =>
  text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

const property = (text: string) => data(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

const posix = (value: string, pathApi: PathApi) => value.split(pathApi.sep).join('/');

export function sourcePath(
  file: string,
  { okRoot, workspace, override, pathApi }: SourceRoots,
): string {
  const root = override ?? posix(pathApi.relative(workspace, okRoot), pathApi);
  const inRoot = posix(pathApi.relative(okRoot, file), pathApi);
  return root === '' ? inRoot : `${root}/${inRoot}`;
}

function callSite(stack: string | undefined, file: string): Location | undefined {
  for (const line of (stack ?? '').split('\n')) {
    const frame = /^\s*at (?:.*\()?(.+):(\d+):(\d+)\)?$/.exec(line);
    if (frame?.[1] === file) return { file, line: Number(frame[2]), column: Number(frame[3]) };
  }
  return undefined;
}

export function annotationTitle(title: string): string {
  const characters = Array.from(title);
  if (characters.length <= GITHUB_TITLE_LIMIT) return title;
  return `${characters.slice(0, GITHUB_TITLE_LIMIT - TRUNCATION_MARK.length).join('')}${TRUNCATION_MARK}`;
}

export default class FinalFailureAnnotations {
  private configTags: string[] = [];
  private run: Run = { allTests: () => [] };
  private readonly annotated = new Set<string>();
  private readonly runErrors: string[] = [];
  private readonly roots: SourceRoots = {
    okRoot: OK_ROOT,
    workspace: env.GITHUB_WORKSPACE ?? cwd(),
    override: env.OK_ANNOTATION_SOURCE_ROOT,
    pathApi: path,
  };

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: RunConfig, run: Run): void {
    this.configTags = config.tags;
    this.run = run;
  }

  onTestEnd(test: Case): void {
    if (test.outcome() === 'unexpected' && test.results.length > test.retries)
      this.annotateFailure(test);
  }

  onError(error: ReportedError): void {
    this.runErrors.push(
      stripVTControlCharacters(
        error.message ?? error.value ?? 'Playwright reported an error outside any test.',
      ),
    );
  }

  onEnd(result: RunResult): void {
    const tests = this.run.allTests();
    for (const test of tests) if (test.outcome() === 'unexpected') this.annotateFailure(test);
    if (result.status === 'passed' || this.runErrors.length === 0) return;
    const noTestRan = tests.every((test) => test.results.length === 0);
    const level =
      result.status === 'failed' && this.annotated.size === 0 && !noTestRan ? 'warning' : 'error';
    stdout.write(`\n::${level}::${data(this.runErrors.join('\n\n'))}\n`);
  }

  private title(test: Case): string {
    const [, project, , ...titles] = test.titlePath();
    const where = `${posix(path.relative(cwd(), test.location.file), path)}:${test.location.line}:${test.location.column}`;
    const head = `${project ? `[${project}] › ` : ''}${where} › ${titles.join(' › ')}`;
    const extraTags = test.tags.filter(
      (tag) => !head.includes(tag) && !this.configTags.includes(tag),
    );
    return extraTags.length > 0 ? `${head} ${extraTags.join(' ')}` : head;
  }

  private verdict(test: Case): string {
    const tries = test.results.length;
    const allowed = test.retries + 1;
    if (tries === allowed)
      return tries === 1
        ? 'Failed its only try.'
        : `Failed all ${tries} tries; the error below is from the last.`;
    const failed = test.results.filter(
      ({ status }) => !NOT_A_VERDICT.has(status) && status !== test.expectedStatus,
    ).length;
    return `Failed ${failed} of ${allowed} allowed tries; the run stopped before the rest.`;
  }

  private thrownAt(error: ReportedError | undefined, spec: string): string {
    const where = error?.location;
    if (where === undefined || where.file === spec) return '';
    return `Thrown at ${sourcePath(where.file, this.roots)}:${where.line}:${where.column}`;
  }

  private annotateFailure(test: Case): void {
    if (this.annotated.has(test.id)) return;
    this.annotated.add(test.id);
    const errors =
      [...test.results].reverse().find((attempt) => attempt.errors.length > 0)?.errors ?? [];
    const [error] = errors;
    const spec = test.location.file;
    const title = this.title(test);
    const at =
      error?.location?.file === spec
        ? error.location
        : (callSite(error?.stack, spec) ?? test.location);
    const more = errors.length - 1;
    const message = [
      `${this.annotated.size}) ${title}`,
      this.verdict(test),
      stripVTControlCharacters(error?.message ?? error?.value ?? 'Expected to fail, but passed.'),
      this.thrownAt(error, spec),
      stripVTControlCharacters(error?.snippet ?? ''),
      more > 0
        ? `${more} more ${more === 1 ? 'error' : 'errors'} from the same try ${more === 1 ? 'is' : 'are'} in the job log.`
        : '',
    ]
      .filter((part) => part !== '')
      .join('\n');
    const properties = [
      `file=${property(sourcePath(test.location.file, this.roots))}`,
      `line=${at.line}`,
      `col=${at.column}`,
      `title=${property(annotationTitle(title))}`,
    ].join(',');
    stdout.write(`\n::error ${properties}::${data(message)}\n`);
  }
}
