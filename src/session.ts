import {
  LoggingDebugSession,
  InitializedEvent,
  TerminatedEvent,
  ExitedEvent,
  OutputEvent,
  ThreadEvent,
  BreakpointEvent,
  Event,
} from '@vscode/debugadapter';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { BunDebugAdapter, type AdapterHost, type LaunchArgs } from './adapter/adapter';

/**
 * DAP session host. Owns a `BunDebugAdapter` and bridges adapter emissions to
 * DAP events via the `AdapterHost` callbacks. All JSC translation lives in the
 * adapter; this class only does protocol framing/dispatch (via
 * `LoggingDebugSession`) plus client-capability handling.
 */
export class BunDapSession extends LoggingDebugSession {
  private adapter: BunDebugAdapter | null = null;
  private clientSupportsConfigurationDone = true;
  private mode: 'launch' | 'attach' | null = null;

  constructor() {
    super();
    // We publish 1-based lines/columns everywhere (DAP + source-mapped TS).
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  private getAdapter(): BunDebugAdapter {
    if (!this.adapter) {
      const adapter = new BunDebugAdapter();
      adapter.host = this.makeHost();
      this.adapter = adapter;
    }
    return this.adapter;
  }

  private makeHost(): AdapterHost {
    return {
      sendInitialized: () => {
        this.sendEvent(new InitializedEvent());
        // Ancient clients that lack `supportsConfigurationDoneRequest` never
        // send `configurationDone`; release the --inspect-wait gate for them
        // after their configuration requests have had time to arrive.
        if (!this.clientSupportsConfigurationDone) {
          setTimeout(() => {
            void this.getAdapter().configurationDone().catch(() => {
              /* gate already released or inspector gone */
            });
          }, 200);
        }
      },
      sendOutput: (category, text) => this.sendEvent(new OutputEvent(text, category)),
      sendStopped: (reason, threadId, exceptionText, hitBreakpointIds) => {
        const body: Record<string, unknown> = { reason, threadId };
        if (exceptionText) body.exceptionText = exceptionText;
        if (hitBreakpointIds && hitBreakpointIds.length > 0) body.hitBreakpointIds = hitBreakpointIds;
        // StoppedEvent's constructor doesn't expose hitBreakpointIds; build the
        // raw event so the body matches DAP exactly.
        this.sendEvent(new Event('stopped', body));
      },
      sendBreakpointChanged: (bp) => this.sendEvent(new BreakpointEvent('changed', bp)),
      sendTerminated: () => this.sendEvent(new TerminatedEvent()),
      sendExited: (code) => this.sendEvent(new ExitedEvent(code)),
      sendThread: (reason, id) => this.sendEvent(new ThreadEvent(reason, id)),
      sendProcessStarted: (pid) => this.sendEvent(new Event('process', { name: 'bun', systemProcessId: pid })),
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
    // v1.68's InitializeRequestArguments doesn't carry the client's
    // `supportsConfigurationDoneRequest`; nvim-dap and the omp harness both
    // send `configurationDone`, so keep the default of true.
    void args;
    response.body = {
      supportsConfigurationDoneRequest: true,
      supportsFunctionBreakpoints: true,
      supportsConditionalBreakpoints: true,
      supportsHitConditionalBreakpoints: true,
      supportsLogPoints: true,
      supportsEvaluateForHovers: true,
      exceptionBreakpointFilters: [
        { filter: 'all', label: 'All Exceptions', default: false },
        { filter: 'uncaught', label: 'Uncaught Exceptions (mapped to all — JSC limitation)', default: false },
      ],
      supportsTerminateRequest: true,
      supportTerminateDebuggee: true,
      // Deliberately unimplemented (advertise false; base class errors otherwise):
      supportsStepBack: false,
      supportsGotoTargetsRequest: false,
      supportsCompletionsRequest: false,
      supportsLoadedSourcesRequest: false,
      supportsExceptionInfoRequest: false,
      supportsRestartRequest: false,
      supportsSetVariable: false,
      supportsSetExpression: false,
      supportsDataBreakpoints: false,
      supportsBreakpointLocationsRequest: false,
      supportsRestartFrame: false,
      supportsSteppingGranularity: false,
      supportsInstructionBreakpoints: false,
      supportsReadMemoryRequest: false,
      supportsWriteMemoryRequest: false,
      supportsDisassembleRequest: false,
      supportsCancelRequest: false,
    };
    this.sendResponse(response);
  }

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments): Promise<void> {
    this.mode = 'launch';
    try {
      await this.getAdapter().launch(args as unknown as LaunchArgs);
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 1001, (err as Error).message);
    }
  }

  protected async attachRequest(response: DebugProtocol.AttachResponse, args: DebugProtocol.AttachRequestArguments): Promise<void> {
    this.mode = 'attach';
    const url = 'url' in args && typeof args.url === 'string' ? args.url : '';
    try {
      await this.getAdapter().attach({ url });
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 1001, (err as Error).message);
    }
  }

  protected async terminateRequest(response: DebugProtocol.TerminateResponse): Promise<void> {
    try {
      if (this.mode === 'launch') await this.adapter?.terminateDebuggee();
    } catch {
      // child already gone
    }
    this.sendResponse(response);
  }

  protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): Promise<void> {
    const adapter = this.adapter;
    if (adapter) {
      try {
        // Launch always terminates the debuggee; attach only when asked.
        if (this.mode === 'launch' || args.terminateDebuggee) {
          await adapter.terminateDebuggee();
        }
      } catch {
        // already exited
      }
      adapter.closeInspector();
    }
    this.sendResponse(response);
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
    try {
      response.body = { breakpoints: await this.getAdapter().setBreakpoints({ ...args, breakpoints: args.breakpoints ?? [] }) };
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 1003, (err as Error).message);
    }
  }

  protected async setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments): Promise<void> {
    try {
      response.body = { breakpoints: await this.getAdapter().setFunctionBreakpoints(args) };
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 1003, (err as Error).message);
    }
  }

  protected async setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<void> {
    try {
      await this.getAdapter().setExceptionBreakpoints(args);
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 1003, (err as Error).message);
    }
  }

  protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse): Promise<void> {
    try {
      await this.getAdapter().configurationDone();
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 1004, (err as Error).message);
    }
  }

  // -------------------------------------------------------------------------
  // Inspection (only consistent while paused)
  // -------------------------------------------------------------------------

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: this.getAdapter().threads() };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
    try {
      response.body = await this.getAdapter().stackTrace({
        threadId: args.threadId,
        startFrame: args.startFrame ?? 0,
        levels: args.levels ?? 0,
      });
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 1005, (err as Error).message);
    }
  }

  protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
    response.body = { scopes: this.getAdapter().scopes(args.frameId) };
    this.sendResponse(response);
  }

  protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
    try {
      response.body = { variables: await this.getAdapter().variables(args.variablesReference) };
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 1006, (err as Error).message);
    }
  }

  protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
    try {
      response.body = await this.getAdapter().evaluate({
        expression: args.expression,
        frameId: args.frameId,
        context: args.context,
      });
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 1002, (err as Error).message);
    }
  }

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  protected async continueRequest(response: DebugProtocol.ContinueResponse): Promise<void> {
    try {
      await this.adapter?.resume();
    } catch {
      // resume only valid while paused — no-op when running
    }
    this.sendResponse(response);
  }

  protected async nextRequest(response: DebugProtocol.NextResponse): Promise<void> {
    try {
      await this.adapter?.next();
    } catch {
      // not paused
    }
    this.sendResponse(response);
  }

  protected async stepInRequest(response: DebugProtocol.StepInResponse): Promise<void> {
    try {
      await this.adapter?.stepIn();
    } catch {
      // not paused
    }
    this.sendResponse(response);
  }

  protected async stepOutRequest(response: DebugProtocol.StepOutResponse): Promise<void> {
    try {
      await this.adapter?.stepOut();
    } catch {
      // not paused
    }
    this.sendResponse(response);
  }

  protected async pauseRequest(response: DebugProtocol.PauseResponse): Promise<void> {
    try {
      await this.adapter?.pause();
    } catch {
      // already paused
    }
    this.sendResponse(response);
  }
}
