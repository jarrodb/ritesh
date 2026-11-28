// Messages between the jq command and its worker.
export interface JqRequest {
  id: number
  input: string
  filter: string
  flags: string[]
  wasmURL: string
  /** Lines of output sent back at most; the rest is dropped in the worker. */
  maxLines: number
  /** Characters of output sent back at most. */
  maxChars: number
}

export interface JqResponse {
  id: number
  stdout: string
  stderr: string
  exitCode: number
  /** The output went past maxLines or maxChars and was cut. */
  cut?: boolean
}
