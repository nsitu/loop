// Allow CSS side-effect imports
declare module '*.css' {
  const _: unknown
  export default _
}

// FileSystemFileHandle.queryPermission is a newer API not yet in TS lib
interface FileSystemFileHandle {
  queryPermission(desc: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
}
