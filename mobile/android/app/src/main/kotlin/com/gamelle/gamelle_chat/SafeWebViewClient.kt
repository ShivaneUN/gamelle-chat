package com.gamelle.gamelle_chat

import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Build
import android.os.Message
import android.view.KeyEvent
import android.webkit.ClientCertRequest
import android.webkit.HttpAuthHandler
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.annotation.RequiresApi

/**
 * Empêche Android de tuer l’appli quand le processus renderer Chromium
 * est tué (OOM). Délègue le reste au client Flutter.
 */
class SafeWebViewClient(
    private val inner: WebViewClient,
    private val onGone: (WebView) -> Unit,
) : WebViewClient() {
    @RequiresApi(Build.VERSION_CODES.O)
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        onGone(view)
        return true
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        return inner.shouldOverrideUrlLoading(view, request)
    }

    @Deprecated("Deprecated in Java")
    override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
        @Suppress("DEPRECATION")
        return inner.shouldOverrideUrlLoading(view, url)
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        inner.onPageStarted(view, url, favicon)
    }

    override fun onPageFinished(view: WebView, url: String) {
        inner.onPageFinished(view, url)
    }

    override fun onReceivedHttpError(
        view: WebView,
        request: WebResourceRequest,
        errorResponse: WebResourceResponse,
    ) {
        inner.onReceivedHttpError(view, request, errorResponse)
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        inner.onReceivedError(view, request, error)
    }

    @Deprecated("Deprecated in Java")
    override fun onReceivedError(view: WebView, errorCode: Int, description: String, failingUrl: String) {
        @Suppress("DEPRECATION")
        inner.onReceivedError(view, errorCode, description, failingUrl)
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
        inner.doUpdateVisitedHistory(view, url, isReload)
    }

    override fun onReceivedHttpAuthRequest(
        view: WebView,
        handler: HttpAuthHandler,
        host: String,
        realm: String,
    ) {
        inner.onReceivedHttpAuthRequest(view, handler, host, realm)
    }

    override fun onFormResubmission(view: WebView, dontResend: Message, resend: Message) {
        inner.onFormResubmission(view, dontResend, resend)
    }

    override fun onLoadResource(view: WebView, url: String) {
        inner.onLoadResource(view, url)
    }

    override fun onPageCommitVisible(view: WebView, url: String) {
        inner.onPageCommitVisible(view, url)
    }

    override fun onReceivedClientCertRequest(view: WebView, request: ClientCertRequest) {
        inner.onReceivedClientCertRequest(view, request)
    }

    override fun onReceivedLoginRequest(view: WebView, realm: String, account: String?, args: String) {
        inner.onReceivedLoginRequest(view, realm, account, args)
    }

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        inner.onReceivedSslError(view, handler, error)
    }

    override fun onScaleChanged(view: WebView, oldScale: Float, newScale: Float) {
        inner.onScaleChanged(view, oldScale, newScale)
    }

    override fun onUnhandledKeyEvent(view: WebView, event: KeyEvent) {
        inner.onUnhandledKeyEvent(view, event)
    }

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        return inner.shouldInterceptRequest(view, request)
    }
}
