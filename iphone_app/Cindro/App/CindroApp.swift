import SwiftUI

/// App entry point. Holds the process-wide [AppState] (the iOS analogue of Android's
/// `JarvisApp` Application singleton) and renders [RootView].
@main
struct CindroApp: App {
    @StateObject private var app = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .tint(.accentColor)
        }
    }
}
