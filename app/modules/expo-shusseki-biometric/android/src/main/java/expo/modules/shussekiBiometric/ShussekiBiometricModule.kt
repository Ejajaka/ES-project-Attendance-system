package expo.modules.shussekiBiometric

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.util.concurrent.Executor

/**
 * On-device biometric check (fingerprint/face) used at attendance boundaries as
 * a supporting anti-spoofing signal (non-core). Verify on device; FaceManager
 * is unavailable on many OEM skins, so the caller should tolerate failure.
 */
class ShussekiBiometricModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ShussekiBiometric")

    AsyncFunction("perform") { kind: String ->
      perform(kind)
    }
  }

  private fun perform(kind: String): Map<String, Any> {
    val activity = appContext.currentActivity as? FragmentActivity
      ?: return result(kind, false)
    val executor: Executor = ContextCompat.getMainExecutor(activity)
    val promptInfo = BiometricPrompt.PromptInfo.Builder()
      .setTitle("Shusseki attendance")
      .setSubtitle("Confirm it is you (${kind})")
      .setNegativeButtonText("Cancel")
      .build()

    var success = false
    val latch = java.util.concurrent.CountDownLatch(1)
    val prompt = BiometricPrompt(activity, executor,
      object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          success = true
          latch.countDown()
        }
        override fun onAuthenticationError(code: Int, err: CharSequence) {
          latch.countDown()
        }
        override fun onAuthenticationFailed() {
          latch.countDown()
        }
      })
    activity.runOnUiThread { prompt.authenticate(promptInfo) }
    latch.await(30, java.util.concurrent.TimeUnit.SECONDS)
    return result(kind, success)
  }

  private fun result(kind: String, success: Boolean): Map<String, Any> {
    return mapOf(
      "performedAt" to System.currentTimeMillis(),
      "kind" to kind,
      "success" to success,
    )
  }
}
