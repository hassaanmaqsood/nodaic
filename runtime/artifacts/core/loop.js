/** loop — input: { items: any[] } */
export default {
    id: 'loop',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'loop', description: 'input: { items: any[] }', tags: ['core'] },
    source: `
        const items = input.items ?? [];
        const cursor = state.cursor ?? 0;

        if (cursor >= items.length) {
            returnCallback({ output: { done: true, index: cursor }, state: { ...state, cursor: 0 } });
            return;
        }

        returnCallback({ output: { item: items[cursor], index: cursor, done: false }, state: { ...state, cursor: cursor + 1 } });
    `,
    interface: {
        inputs:  { items: { type: 'array', required: true } },
        outputs: { item: { type: 'any' }, index: { type: 'number' }, done: { type: 'boolean' } }
    }
};
