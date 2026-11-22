// A hot day's answer as its move stores it: the move's first step has run,
// so a sweep brokers answer says the day takes no more codes.
export const asMoved = (hot: string | undefined) =>
  hot?.replace('"takesCodes":true', '"takesCodes":false')
