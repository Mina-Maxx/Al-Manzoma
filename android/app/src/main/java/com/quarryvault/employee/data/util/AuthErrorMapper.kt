package com.quarryvault.employee.data.util

data class LocalizedMessage(
    val english: String,
    val arabic: String
) {
    val display: String get() = "$arabic\n$english"
}

object AuthErrorMapper {

    fun mapSupabaseError(
        statusCode: Int,
        rawMessage: String,
        code: String? = null
    ): LocalizedMessage {
        val lower = rawMessage.lowercase()
        return when {
            lower.contains("invalid login credentials") ||
            lower.contains("invalid_grant") ||
            statusCode == 400 && lower.contains("credentials") -> {
                LocalizedMessage(
                    english = "Incorrect email or password.",
                    arabic = "البريد الإلكتروني أو كلمة المرور غير صحيحة."
                )
            }
            lower.contains("email not confirmed") -> {
                LocalizedMessage(
                    english = "Email address has not been confirmed yet.",
                    arabic = "لم يتم تأكيد البريد الإلكتروني بعد."
                )
            }
            lower.contains("rate limit") || statusCode == 429 -> {
                LocalizedMessage(
                    english = "Too many attempts. Please try again later.",
                    arabic = "تم تجاوز عدد المحاولات المسموح به. يرجى المحاولة لاحقاً."
                )
            }
            statusCode == 401 -> {
                LocalizedMessage(
                    english = "Authentication failed. Please check credentials or API key.",
                    arabic = "فشل التحقق من الهوية. يرجى مراجعة البيانات المدخلة ومفتاح الخدمة."
                )
            }
            else -> {
                LocalizedMessage(
                    english = "Authentication error: $rawMessage",
                    arabic = "خطأ في تسجيل الدخول: $rawMessage"
                )
            }
        }
    }

    fun mapBackendError(
        statusCode: Int,
        detail: String,
        code: String? = null
    ): LocalizedMessage {
        val lower = detail.lowercase()
        return when {
            statusCode == 401 -> {
                LocalizedMessage(
                    english = "Session expired or invalid token. Please sign in again.",
                    arabic = "انتهت صلاحية الجلسة أو الرمز غير صالح. يرجى تسجيل الدخول مجدداً."
                )
            }
            statusCode == 403 && lower.contains("user not provisioned") -> {
                LocalizedMessage(
                    english = "Your account is not provisioned in QuarryVault. Contact your administrator.",
                    arabic = "هذا الحساب غير مسجل في منظومة محاجر. يرجى التواصل مع مسؤول الشركة."
                )
            }
            statusCode == 403 && lower.contains("user is not active") -> {
                LocalizedMessage(
                    english = "Your employee account has been deactivated. Please contact support.",
                    arabic = "تم إيقاف حسابك الوظيفي. يرجى مراجعة إدارة الشركة."
                )
            }
            statusCode == 403 && (lower.contains("company is not active") || lower.contains("suspended")) -> {
                LocalizedMessage(
                    english = "Company subscription is inactive or suspended.",
                    arabic = "حساب الشركة غير مفعل أو موقوف حالياً."
                )
            }
            statusCode == 403 && lower.contains("no company membership") -> {
                LocalizedMessage(
                    english = "No company membership found for this user account.",
                    arabic = "لا توجد عضوية شركة مرتبطة بهذا الحساب."
                )
            }
            statusCode == 403 -> {
                LocalizedMessage(
                    english = "Access denied: $detail",
                    arabic = "تم رفض الوصول: $detail"
                )
            }
            statusCode == 404 -> {
                LocalizedMessage(
                    english = "Employee profile or company not found.",
                    arabic = "لم يتم العثور على بيانات الموظف أو الشركة."
                )
            }
            statusCode >= 500 -> {
                LocalizedMessage(
                    english = "QuarryVault server error ($statusCode). Please try again later.",
                    arabic = "خطأ في خادم النظام ($statusCode). يرجى المحاولة لاحقاً."
                )
            }
            else -> {
                LocalizedMessage(
                    english = "Error ($statusCode): $detail",
                    arabic = "خطأ ($statusCode): $detail"
                )
            }
        }
    }

    fun mapNetworkError(throwable: Throwable): LocalizedMessage {
        val msg = throwable.localizedMessage ?: throwable.javaClass.simpleName
        return LocalizedMessage(
            english = "Network connection failed. Please check your internet connection ($msg).",
            arabic = "تعذر الاتصال بالخادم. يرجى التحقق من اتصالك بالإنترنت ($msg)."
        )
    }
}
