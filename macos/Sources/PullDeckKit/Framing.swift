import Foundation

/// Chrome's native messaging wire format.
///
/// Documented as: "each message is serialized using JSON, UTF-8 encoded and is
/// preceded with 32-bit message length in native byte order." Native byte order
/// on every Mac Chrome supports is little-endian, but this code reads and
/// writes through `UInt32` in host order rather than hard-coding that, so it
/// stays correct if it is ever built somewhere big-endian.
public enum NativeMessaging {
    /// "The maximum size of a single message from the native messaging host is
    /// 1 MB, mainly to protect Chrome from misbehaving native applications."
    public static let maxToExtension = 1_024 * 1_024

    /// "The maximum size of the message sent to the native messaging host is 64 MiB."
    public static let maxFromExtension = 64 * 1_024 * 1_024

    public static let headerSize = 4

    public enum FramingError: Error, Equatable {
        case shortHeader
        case tooLarge(Int, limit: Int)
        case emptyMessage
    }

    /// Length prefix + payload, ready to write to stdout.
    public static func frame(_ payload: Data) throws -> Data {
        guard !payload.isEmpty else { throw FramingError.emptyMessage }
        guard payload.count <= maxToExtension else {
            throw FramingError.tooLarge(payload.count, limit: maxToExtension)
        }
        var length = UInt32(payload.count)
        var out = Data(capacity: headerSize + payload.count)
        withUnsafeBytes(of: &length) { out.append(contentsOf: $0) }
        out.append(payload)
        return out
    }

    /// Decode a 4-byte header into a payload length, rejecting implausible sizes.
    public static func payloadLength(header: Data, limit: Int = maxFromExtension) throws -> Int {
        guard header.count == headerSize else { throw FramingError.shortHeader }
        let length = header.withUnsafeBytes { raw in
            raw.loadUnaligned(as: UInt32.self)
        }
        let count = Int(length)
        guard count > 0 else { throw FramingError.emptyMessage }
        guard count <= limit else { throw FramingError.tooLarge(count, limit: limit) }
        return count
    }

    /// Split a buffer into whole messages, returning the unconsumed remainder.
    /// Chrome's pipe delivers arbitrary chunks, so a message can straddle reads.
    public static func drain(
        buffer: inout Data,
        limit: Int = maxFromExtension
    ) throws -> [Data] {
        var messages: [Data] = []
        while buffer.count >= headerSize {
            let header = buffer.prefix(headerSize)
            let length = try payloadLength(header: Data(header), limit: limit)
            guard buffer.count >= headerSize + length else { break }  // wait for more
            let start = buffer.index(buffer.startIndex, offsetBy: headerSize)
            let end = buffer.index(start, offsetBy: length)
            messages.append(Data(buffer[start..<end]))
            buffer = Data(buffer[end...])
        }
        return messages
    }
}
