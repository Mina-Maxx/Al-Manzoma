package com.quarryvault.employee

import android.os.Bundle
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import com.quarryvault.employee.data.repository.DefaultEmployeeRepository
import com.quarryvault.employee.data.session.SharedPreferencesSessionStorage
import com.quarryvault.employee.ui.screens.EmployeeAppScreen
import com.quarryvault.employee.ui.screens.EmployeeAppViewModel
import com.quarryvault.employee.ui.theme.QuarryVaultTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL
        val sessionStorage = SharedPreferencesSessionStorage(applicationContext)
        val repository = DefaultEmployeeRepository(sessionStorage = sessionStorage)
        setContent {
            QuarryVaultTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    val viewModel: EmployeeAppViewModel = viewModel(
                        factory = object : ViewModelProvider.Factory {
                            @Suppress("UNCHECKED_CAST")
                            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                                val vm = EmployeeAppViewModel(
                                    repository = repository
                                )
                                vm.customCacheDir = applicationContext.cacheDir
                                return vm as T
                            }
                        }
                    )
                    EmployeeAppScreen(viewModel = viewModel)
                }
            }
        }
    }
}
