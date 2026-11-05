package com.quarryvault.employee.data.util

data class LocalizedMessage(
    val english: String,
    val arabic: String
) {
    val display: String get() = arabic
}

object AuthErrorMapper {


    fun mapLoginError(
        statusCode: Int,
        rawMessage: String,
        code: String? = null
    ): LocalizedMessage {
        val lower = rawMessage.lowercase()
        return when {
            code == "PLATFORM_ADMIN_NOT_ALLOWED" -> {
                LocalizedMessage(
                    english = "Platform Admin accounts must use the Platform Admin Dashboard.",
                    arabic = "يجب استخدام لوحة مسؤولي المنصة لهذا الحساب."
                )
            }
            (statusCode == 400 || statusCode == 401) &&
            (lower.contains("invalid") || lower.contains("credential") || lower.contains("password") || lower.contains("username") || lower.contains("invalid_grant")) -> {
                LocalizedMessage(
                    english = "Incorrect username or password.",
                    arabic = "اسم المستخدم أو كلمة المرور غير صحيحة."
                )
            }
            statusCode == 401 && (lower.contains("inactive") || lower.contains("disabled")) -> {
                LocalizedMessage(
                    english = "Account is inactive or disabled. Contact administrator.",
                    arabic = "الحساب غير مفعل أو معطل. يرجى مراجعة إدارة الشركة."
                )
            }
            statusCode == 503 || statusCode == 504 -> {
                LocalizedMessage(
                    english = "Authentication service temporarily unavailable. Please try again shortly.",
                    arabic = "خدمة المصادقة غير متاحة مؤقتاً. يرجى المحاولة بعد قليل."
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
                    english = "Authentication could not be completed. Please check your details and try again.",
                    arabic = "تعذر تسجيل الدخول. يرجى التحقق من البيانات والمحاولة مرة أخرى."
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
            code == "SESSION_INVALIDATED" ||
            lower.contains("session_terminated_by_new_login") ||
            lower.contains("logged in from another device") ||
            lower.contains("logged_in_from_another_device") -> {
                LocalizedMessage(
                    english = "Logged in from another device.",
                    arabic = "تم تسجيل الدخول من جهاز آخر"
                )
            }
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
                    english = "You do not have permission to complete this action.",
                    arabic = "ليس لديك صلاحية لتنفيذ هذا الإجراء."
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
                    english = "The request could not be completed. Please try again.",
                    arabic = "تعذر إكمال الطلب. يرجى المحاولة مرة أخرى."
                )
            }
        }
    }

    fun mapNetworkError(throwable: Throwable): LocalizedMessage {
        val msg = throwable.localizedMessage ?: throwable.javaClass.simpleName
        return LocalizedMessage(
            english = "Network connection failed. Please check your internet connection ($msg).",
            arabic = "تعذر الاتصال بالخادم. يرجى التحقق من اتصالك بالإنترنت والمحاولة مرة أخرى."
        )
    }
}
