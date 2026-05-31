/**
 * Platform-specific response formatters.
 * Takes normalized decision from routing.mjs -> platform-specific JSON output.
 */

export const formatters = {
  "claude-code": {
    deny: (reason) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    ask: () => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
      },
    }),
    modify: (updatedInput) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Routed to context-mode sandbox",
        updatedInput,
      },
    }),
    context: (additionalContext) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext,
      },
    }),
  },

  "gemini-cli": {
    deny: (reason) => ({ decision: "deny", reason }),
    ask: () => null, // Gemini CLI has no "ask" concept
    modify: (updatedInput) => ({
      hookSpecificOutput: { tool_input: updatedInput },
    }),
    context: (additionalContext) => ({
      hookSpecificOutput: { additionalContext },
    }),
  },

  "vscode-copilot": {
    deny: (reason) => ({
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    }),
    ask: () => ({
      permissionDecision: "ask",
    }),
    modify: (updatedInput) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Routed to context-mode sandbox",
        updatedInput,
      },
    }),
    context: (additionalContext) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext,
      },
    }),
  },

  "jetbrains-copilot": {
    deny: (reason) => ({
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    }),
    ask: () => ({
      permissionDecision: "ask",
    }),
    modify: (updatedInput) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Routed to context-mode sandbox",
        updatedInput,
      },
    }),
    context: (additionalContext) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext,
      },
    }),
  },

  "codex": {
    deny: (reason) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    ask: () => null, // Codex rejects permissionDecision: "ask" in PreToolUse
    modify: () => null, // Codex rejects updatedInput in PreToolUse
    context: () => null, // Codex rejects additionalContext in PreToolUse (fails open)
  },

  "kimi": {
    // Kimi Code / Kimi CLI hook runners parse ONLY `permissionDecision === "deny"`
    // for structured PreToolUse output. Anything else (ask / allow+updatedInput /
    // additionalContext) is silently dropped, and the host's HookResult type has
    // no `additionalContext` field at all.
    //   Evidence: refs/platforms/kimi-code/packages/agent-core/src/session/hooks/
    //     runner.ts:36-39,162-178  (HookSpecificOutputSchema + structuredOutput())
    //   Evidence: refs/platforms/kimi-code/packages/agent-core/src/session/hooks/
    //     types.ts:28-37            (HookResult has no additionalContext)
    //   Evidence: refs/platforms/kimi-cli/src/kimi_cli/hooks/runner.py:62-89
    //     (Python runtime behaves identically)
    // This mirrors the codex precedent established at commit 607dc70 (#225),
    // where the same upstream "deny-only" parser forced ask/modify/context to
    // return null in the formatter rather than emit fields the host ignores.
    deny: (reason) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
    ask: () => null,     // Kimi runner ignores permissionDecision !== "deny"
    modify: () => null,  // Kimi runner has no updatedInput channel
    context: () => null, // Kimi HookResult has no additionalContext field
  },

  "cursor": {
    deny: (reason) => ({
      permission: "deny",
      user_message: reason,
    }),
    ask: () => ({
      permission: "ask",
    }),
    modify: (updatedInput) => ({
      updated_input: updatedInput,
    }),
    context: (additionalContext) => ({
      agent_message: additionalContext,
    }),
  },
};

/**
 * Apply a formatter to a normalized routing decision.
 * Returns the platform-specific JSON response, or null for passthrough.
 */
export function formatDecision(platform, decision) {
  if (!decision) return null;

  const fmt = formatters[platform];
  if (!fmt) return null;

  switch (decision.action) {
    case "deny": return fmt.deny(decision.reason);
    case "ask": return fmt.ask();
    case "modify": return fmt.modify(decision.updatedInput);
    case "context": return fmt.context(decision.additionalContext);
    default: return null;
  }
}
