import SwiftUI

extension View {
    /// A dismissible error alert bound to an optional message. Using a real two-way
    /// `Binding` (not `.constant(...)`) means SwiftUI can clear it on any dismissal — the
    /// `.constant` form is read-only and can re-present or stick. Shared so the four
    /// screens that surface errors don't each hand-roll the fragile idiom.
    func errorAlert(_ message: Binding<String?>, title: String = "Something went wrong") -> some View {
        alert(title, isPresented: Binding(
            get: { message.wrappedValue != nil },
            set: { if !$0 { message.wrappedValue = nil } }
        )) {
            Button("OK") { message.wrappedValue = nil }
        } message: {
            Text(message.wrappedValue ?? "")
        }
    }
}
