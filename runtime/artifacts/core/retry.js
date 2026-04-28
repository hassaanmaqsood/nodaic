/** retry — input: { fn: string, maxAttempts?, backoffMs? } */
export default {
    id: 'retry',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'retry', description: 'input: { fn: string, maxAttempts?, backoffMs? }', tags: ['core'] },
    source: `
        const fnStr = input.fn ?? state.fn;
        if (!fnStr) return returnCallback({ output: { ok: false, error: 'No function provided' }, state });

        const fn = new Function('return (' + fnStr + ')')();
        const maxAttempts = input.maxAttempts ?? state.maxAttempts ?? 3;
        const backoffMs = input.backoffMs ?? state.backoffMs ?? 500;
        let attempts = 0;

        const attempt = () => {
            attempts++;
            try {
                const outcome = fn();
                const handle = (res) => {
                    if (res?.ok || attempts >= maxAttempts) returnCallback({ output: { ...res, attempts }, state });
                    else setTimeout(attempt, backoffMs * attempts);
                };
                outcome?.then
                    ? outcome.then(handle).catch(err => {
                        if (attempts >= maxAttempts) returnCallback({ output: { ok: false, error: err.message, attempts }, state });
                        else setTimeout(attempt, backoffMs * attempts);
                    })
                    : handle(outcome);
            } catch (err) {
                if (attempts >= maxAttempts) returnCallback({ output: { ok: false, error: err.message, attempts }, state });
                else setTimeout(attempt, backoffMs * attempts);
            }
        };

        attempt();
    `,
    interface: {
        inputs: { 
            fn: { type: 'string', required: true }, 
            maxAttempts: { type: 'number' }, 
            backoffMs: { type: 'number' } 
        },
        outputs: { 
            ok: { type: 'boolean' }, 
            error: { type: 'string' }, 
            attempts: { type: 'number' } 
        }
    }
};
