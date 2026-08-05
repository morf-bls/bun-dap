/**
 * Hand-written minimal WebKit (JSC) inspector protocol types for Bun.
 * All line/column numbers are 0-based in and out, matching JSC.
 */

/** A call frame id from JSC. It is an object in practice; echo it back verbatim. */
export type CallFrameId = string | { ordinal: number; injectedScriptId: number };

export interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
  className?: string;
  preview?: ObjectPreview;
}

export interface ObjectPreview {
  type: string;
  subtype?: string;
  description?: string;
  overflow?: boolean;
  properties?: PropertyPreview[];
  entries?: EntryPreview[];
}

export interface PropertyPreview {
  name: string;
  type: string;
  value?: string;
  valuePreview?: ObjectPreview;
  subtype?: string;
}

export interface EntryPreview {
  key?: RemoteObject;
  value?: RemoteObject;
}

export interface Location {
  scriptId: string;
  lineNumber: number; // 0-based
  columnNumber: number; // 0-based
}

export interface Scope {
  type: 'global' | 'closure' | 'local' | 'with' | 'catch' | 'block' | 'script' | 'eval' | string;
  object: RemoteObject;
  name?: string;
}

export interface PropertyDescriptor {
  name: string;
  value?: RemoteObject;
  writable?: boolean;
  configurable?: boolean;
  enumerable?: boolean;
}

export interface CallFrame {
  callFrameId: CallFrameId;
  functionName: string;
  functionLocation?: Location;
  location: Location;
  url?: string;
  scopeChain: Scope[];
  this: RemoteObject;
}

// ---- Request params / results ----

export interface RuntimeEvaluateParams {
  expression: string;
  returnByValue?: boolean;
  objectGroup?: string;
  includeCommandLineAPI?: boolean;
  silent?: boolean;
  generatePreview?: boolean;
}

export interface RuntimeGetDisplayablePropertiesParams {
  objectId: string;
  ownProperties?: boolean;
  generatePreview?: boolean;
}

export interface RuntimeGetDisplayablePropertiesResult {
  /** Bun/JSC reply with the array under `properties`, not `result`. */
  properties?: PropertyDescriptor[];
  result?: PropertyDescriptor[];
  internalProperties?: PropertyDescriptor[];
}

export interface SetBreakpointByUrlParams {
  url: string;
  lineNumber: number; // 0-based
  columnNumber?: number; // 0-based
  condition?: string;
  isAutoContinue?: boolean;
  actions?: unknown[];
}

export interface SetBreakpointByUrlResult {
  breakpointId: string;
  locations: Location[];
}

export interface AddSymbolicBreakpointParams {
  symbol: string;
  isRegex?: boolean;
  condition?: string;
  isAutoContinue?: boolean;
  actions?: unknown[];
}

export interface AddSymbolicBreakpointResult {
  breakpointId: string;
}

export interface EvaluateOnCallFrameParams {
  callFrameId: CallFrameId;
  expression: string;
  objectGroup?: string;
  includeCommandLineAPI?: boolean;
  returnByValue?: boolean;
  silent?: boolean;
  generatePreview?: boolean;
}

export interface EvaluateOnCallFrameResult {
  result: RemoteObject;
  wasThrown?: boolean;
}

export interface GetScriptSourceResult {
  scriptSource: string;
}

export interface RuntimeEvaluateResult {
  result: RemoteObject;
  wasThrown?: boolean;
  exceptionDetails?: unknown;
}

// ---- Events ----

export interface ScriptParsedEvent {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  startLine: number;
  startColumn: number;
}

export interface PausedEvent {
  callFrames: CallFrame[];
  reason: string;
  data?: {
    breakpoints?: string[];
    [key: string]: unknown;
  };
}

export interface BreakpointResolvedEvent {
  breakpointId: string;
  location: Location;
}

// ---- Request/result map (drives send() typing) ----

export interface DevRequestMap {
  'Inspector.enable': { params?: undefined; result: undefined };
  'Inspector.initialized': { params?: undefined; result: undefined };
  'Runtime.enable': { params?: undefined; result: undefined };
  'Runtime.evaluate': { params: RuntimeEvaluateParams; result: RuntimeEvaluateResult };
  'Runtime.getDisplayableProperties': {
    params: RuntimeGetDisplayablePropertiesParams;
    result: RuntimeGetDisplayablePropertiesResult;
  };
  'Console.enable': { params?: undefined; result: undefined };
  'Debugger.enable': { params?: undefined; result: undefined };
  'Debugger.setBreakpointsActive': { params: { active: boolean }; result: undefined };
  'Debugger.setAsyncStackTraceDepth': { params: { depth: number }; result: undefined };
  'Debugger.setBreakpointByUrl': { params: SetBreakpointByUrlParams; result: SetBreakpointByUrlResult };
  'Debugger.removeBreakpoint': { params: { breakpointId: string }; result: undefined };
  'Debugger.addSymbolicBreakpoint': {
    params: AddSymbolicBreakpointParams;
    result: AddSymbolicBreakpointResult;
  };
  'Debugger.removeSymbolicBreakpoint': { params: { symbol: string }; result: undefined };
  'Debugger.setPauseOnExceptions': { params: { state: 'none' | 'all' | 'uncaught' }; result: undefined };
  'Debugger.pause': { params?: undefined; result: undefined };
  'Debugger.resume': { params?: undefined; result: undefined };
  'Debugger.stepNext': { params?: undefined; result: undefined };
  'Debugger.stepInto': { params?: undefined; result: undefined };
  'Debugger.stepOut': { params?: undefined; result: undefined };
  'Debugger.evaluateOnCallFrame': {
    params: EvaluateOnCallFrameParams;
    result: EvaluateOnCallFrameResult;
  };
  'Debugger.getScriptSource': { params: { scriptId: string }; result: GetScriptSourceResult };
}

export type DevRequest = keyof DevRequestMap;
export type ResultOf<M extends DevRequest> = DevRequestMap[M]['result'];

export interface InspectorEvent {
  method: string;
  params: unknown;
}
