/**
 * @file diff.ts
 * @description JSON Patch (RFC 6902) client application logic for differential synchronization.
 */
export interface PatchOperation {
    op: 'add' | 'remove' | 'replace';
    path: string;
    value?: any;
}
/**
 * Applies a list of RFC 6902 JSON patch operations to a base object and returns the modified copy.
 */
export declare function applyPatch(obj: any, patches: PatchOperation[]): any;
//# sourceMappingURL=diff.d.ts.map