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

  private fun perform(kind: String): Map<String, Any?> {
    val activity = appContext.currentActivity as? FragmentActivity
      ?: return result(kind, false, "no activity")

    // Don't show a dead prompt when the device can't biometrically authenticate.
    // We ask for STRONG (fingerprint) specifically — our default kind — and if
    // none is enrolled or the sensor is unavailable, report why instead.
    val manager = BiometricManager.from(activity)
    val can = manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
    if (can != BiometricManager.BIOMETRIC_SUCCESS) {
      val reason = when (can) {
        BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "no biometric hardware"
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "no biometric enrolled"
        BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "biometric hardware unavailable"
        else -> "canAuthenticate=$can"
      }
      return result(kind, false, reason)
    }

    val executor: Executor = ContextCompat.getMainExecutor(activity)
    val promptInfo = BiometricPrompt.PromptInfo.Builder()
      .setTitle("Shusseki attendance")
      .setSubtitle("Confirm it is you (${kind})")
      .setNegativeButtonText("Cancel")
      .build()

    var success = false
    var failureReason: String? = null
    val latch = java.util.concurrent.CountDownLatch(1)
    val prompt = BiometricPrompt(activity, executor,
      object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          success = true
          latch.countDown()
        }
        override fun onAuthenticationError(code: Int, err: CharSequence) {
          failureReason = err.toString()
          latch.countDown()
        }
        override fun onAuthenticationFailed() {
          // Not a terminal error (e.g. partial print); keep waiting for retry.
        }
      })
    activity.runOnUiThread { prompt.authenticate(promptInfo) }
    latch.await(30, java.util.concurrent.TimeUnit.SECONDS)
    return result(kind, success, failureReason)
  }

  private fun result(kind: String, success: Boolean, reason: String? = null): Map<String, Any?> {
    return mapOf(
      "performedAt" to System.currentTimeMillis(),
      "kind" to kind,
      "success" to success,
      "reason" to reason,
    )
  }
}
