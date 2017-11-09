const { URL } = require("url")

let requestCountCache = null

export default url => {
  const cache = requestCountCache
  if (cache) {
    const host = new URL(url).host
    if (cache[host]) {
      cache[host] = cache[host] + 1
    } else {
      cache[host] = 1
    }
  }
}

// This will only be triggered in non-production environments
export const fetchLoggerSetup = () => {
  requestCountCache = {}
}

// Called at the end of a request, returns the results and resets
export const fetchLoggerRequestDone = () => {
  const requestAPICounts = requestCountCache
  requestCountCache = {}
  return {
    requestAPICounts,
  }
}
