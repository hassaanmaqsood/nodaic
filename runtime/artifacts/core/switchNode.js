/** switch — input: { value: string|number, cases: { [key]: any }, default?: any } */
export default {
    id: 'switchNode',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'switch', description: 'input: { value, cases, default? }', tags: ['core'] },
    source: `
        const { value, cases = {}, default: fallback = null } = input;
        const key = String(value);
        returnCallback({ output: { result: key in cases ? cases[key] : fallback, matched: key in cases ? key : '__default__' }, state });
    `,
    interface: {
        inputs:  { value: { type: 'any', required: true }, cases: { type: 'object', required: true }, default: { type: 'any' } },
        outputs: { result: { type: 'any' }, matched: { type: 'string' } }
    }
};
