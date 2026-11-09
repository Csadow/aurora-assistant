package local.aurora.mobile;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.security.keystore.*;
import android.speech.tts.TextToSpeech;
import android.text.InputType;
import android.util.Base64;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import org.json.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;
import java.io.*;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.*;
import java.util.concurrent.*;
import java.util.zip.*;

/** Offline asset shell. No desktop bridge, arbitrary URLs, filesystem paths, or execution APIs. */
public class MainActivity extends Activity {
  private static final String ORIGIN="https://appassets.androidplatform.net";
  private static final Set<String> ASSETS=new HashSet<>(Arrays.asList("index.html","app.js","core.js","tasks.js","timetable.js","calendar-options.js","task-links.js","planner-core.js","planner.js","storage.js","style.css"));
  private WebView web;
  private TextToSpeech speech;
  private boolean speechReady=false;
  private final ExecutorService network=Executors.newSingleThreadExecutor();
  private final Object requestLock=new Object();
  private volatile HttpsURLConnection connection;
  private String activeId=null, shared="";
  private byte[] pendingExport;
  private ValueCallback<Uri[]> fileChoice;
  private SharedPreferences prefs;

  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);prefs=getSharedPreferences("aurora",MODE_PRIVATE);
    getWindow().setStatusBarColor(Color.rgb(23,25,31));getWindow().setNavigationBarColor(Color.rgb(23,25,31));
    web=new WebView(this);web.setBackgroundColor(Color.rgb(23,25,31));
    android.widget.FrameLayout root=new android.widget.FrameLayout(this);root.addView(web);setContentView(root);
    root.setOnApplyWindowInsetsListener((v,insets)->{
      if(android.os.Build.VERSION.SDK_INT>=30){android.graphics.Insets p=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.ime());v.setPadding(p.left,p.top,p.right,p.bottom);}
      else v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());
      return insets;
    });
    WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setJavaScriptCanOpenWindowsAutomatically(false);settings.setSupportMultipleWindows(false);
    web.addJavascriptInterface(new Bridge(),"AuroraNative");
    web.setWebViewClient(new WebViewClient(){
      @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
        Uri uri=request.getUrl();String path=uri.getPath();String name=path==null||path.isEmpty()?"":path.substring(1);
        if(!ORIGIN.equals(uri.getScheme()+"://"+uri.getAuthority()) || !ASSETS.contains(name) || !"GET".equals(request.getMethod()))return denied();
        try {String mime=name.endsWith(".js")?"text/javascript":name.endsWith(".css")?"text/css":"text/html";
          Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-store");headers.put("X-Content-Type-Options","nosniff");
          return new WebResourceResponse(mime,"UTF-8",200,"OK",headers,getAssets().open(name));
        }catch(IOException e){return denied();}
      }
      @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
        // Never load external HTML into a WebView with a privileged bridge.
        if(request.isForMainFrame() && request.hasGesture() && "https".equals(request.getUrl().getScheme())) {
          try{startActivity(new Intent(Intent.ACTION_VIEW,request.getUrl()));}catch(Exception e){tell("No browser is available.");}
        }
        return true;
      }
    });
    web.setWebChromeClient(new WebChromeClient(){
      @Override public boolean onJsConfirm(WebView view,String url,String message,JsResult result){
        new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("Continue",(d,w)->result.confirm()).setNegativeButton("Cancel",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show();return true;
      }
      @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){
        if(fileChoice!=null)fileChoice.onReceiveValue(null);fileChoice=callback;
        Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
        try{startActivityForResult(i,10);}catch(Exception e){fileChoice.onReceiveValue(null);fileChoice=null;tell("No file picker is available.");}return true;
      }
    });
    speech=new TextToSpeech(this,status->{speechReady=status==TextToSpeech.SUCCESS;});
    acceptShare(getIntent());web.loadUrl(ORIGIN+"/index.html");
  }
  private WebResourceResponse denied(){return new WebResourceResponse("text/plain","UTF-8",403,"Blocked",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));}
  private void js(String code){runOnUiThread(()->{if(web!=null)web.evaluateJavascript(code,null);});}
  private void tell(String message){js("window.auroraNotice && window.auroraNotice("+JSONObject.quote(message)+")");}
  private void result(String id,JSONObject body,String error){
    try{JSONObject out=new JSONObject().put("id",id);if(error!=null)out.put("error",error);else out.put("body",body);
      js("window.auroraResult && window.auroraResult("+out.toString()+")");
    }catch(JSONException ignored){}
  }
  private void acceptShare(Intent intent){
    if(Intent.ACTION_SEND.equals(intent.getAction()) && "text/plain".equals(intent.getType())){
      String value=intent.getStringExtra(Intent.EXTRA_TEXT);if(value!=null)shared=value.length()>6000?value.substring(0,6001):value;
    }
  }
  @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);acceptShare(intent);js("window.auroraShared && window.auroraShared(AuroraNative.takeShared())");}
  private javax.crypto.SecretKey key() throws Exception {
    KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
    if(!store.containsAlias("aurora-gemini")){
      KeyGenerator g=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
      g.init(new KeyGenParameterSpec.Builder("aurora-gemini",KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());g.generateKey();
    }
    return (javax.crypto.SecretKey)store.getKey("aurora-gemini",null);
  }
  private synchronized void storeKey(String value) throws Exception {
    Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());
    String data=Base64.encodeToString(c.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(c.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
    if(!prefs.edit().putString("key",data).commit())throw new IOException("Key storage failed");
  }
  private synchronized String readKey() throws Exception {
    String value=prefs.getString("key","");if(value.isEmpty())throw new IOException("No key");String[] parts=value.split(":");
    Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));
    return new String(c.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);
  }
  private synchronized boolean reserveAttempt(){
    long day=System.currentTimeMillis()/86400000L;int count=prefs.getLong("usage-day",-1)==day?prefs.getInt("usage-count",0):0;
    return count<20 && prefs.edit().putLong("usage-day",day).putInt("usage-count",count+1).commit();
  }
  private void request(String id,String raw){
    HttpsURLConnection conn=null;
    try{
      if(raw.length()>80000)throw new IOException("Request too large");
      JSONObject envelope=new JSONObject(raw);String model=envelope.getString("model");
      if(!model.matches("gemini-[a-z0-9.-]{1,80}"))throw new IOException("Invalid model");
      JSONObject payload=envelope.getJSONObject("payload");
      if(payload.has("tools") || payload.has("cachedContent") || payload.getJSONArray("contents").length()>9)throw new IOException("Unsupported request");
      int output=payload.getJSONObject("generationConfig").getInt("maxOutputTokens");if(output<1||output>2048)throw new IOException("Invalid output limit");
      String secret=readKey();
      synchronized(requestLock){if(!id.equals(activeId))return;if(!reserveAttempt())throw new IOException("Daily limit");}
      conn=(HttpsURLConnection)new URL("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent").openConnection();
      synchronized(requestLock){if(!id.equals(activeId)){conn.disconnect();return;}connection=conn;}
      conn.setInstanceFollowRedirects(false);conn.setConnectTimeout(15000);conn.setReadTimeout(90000);conn.setRequestMethod("POST");conn.setDoOutput(true);
      conn.setRequestProperty("Content-Type","application/json");conn.setRequestProperty("x-goog-api-key",secret);
      byte[] bytes=payload.toString().getBytes(StandardCharsets.UTF_8);conn.setFixedLengthStreamingMode(bytes.length);
      try(OutputStream out=conn.getOutputStream()){out.write(bytes);}
      int status=conn.getResponseCode();
      if(status!=200){
        String error=status==429?"Gemini quota reached. Try later or use offline notes. No retry was sent.":status==400||status==404?"Gemini rejected this model or request. Check the model ID in Settings.":status==401||status==403?"Gemini access was denied. Check the key and account availability.":"Gemini could not complete this request (HTTP "+status+"). No retry was sent.";
        result(id,null,error);return;
      }
      byte[] response=bounded(conn.getInputStream(),512*1024);result(id,new JSONObject(new String(response,StandardCharsets.UTF_8)),null);
    }catch(Exception e){result(id,null,"Daily limit".equals(e.getMessage())?"The app’s 20-attempt daily limit was reached. Offline notes still work.":"No complete reply was received. Check your connection and API key. The provider may have processed the request; Aurora will not retry automatically.");}
    finally{if(conn!=null)conn.disconnect();synchronized(requestLock){if(id.equals(activeId)){activeId=null;connection=null;}}}
  }
  private byte[] bounded(InputStream input,int max) throws IOException {
    try(InputStream in=input;ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1){if(out.size()+n>max)throw new IOException("Response too large");out.write(buffer,0,n);}return out.toByteArray();}
  }
  private void export(String name,byte[] data,String mime){runOnUiThread(()->{
    if(pendingExport!=null){tell("Finish or cancel the current export first.");return;}
    pendingExport=data;Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType(mime).addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,name);
    try{startActivityForResult(i,11);}catch(Exception e){pendingExport=null;tell("No file picker is available.");}
  });}
  @Override protected void onActivityResult(int requestCode,int resultCode,Intent data){
    super.onActivityResult(requestCode,resultCode,data);
    if(requestCode==10 && fileChoice!=null){fileChoice.onReceiveValue(resultCode==RESULT_OK&&data!=null?new Uri[]{data.getData()}:null);fileChoice=null;}
    if(requestCode==11){byte[] bytes=pendingExport;pendingExport=null;
      if(resultCode==RESULT_OK&&data!=null&&bytes!=null){Uri uri=data.getData();network.execute(()->{try(OutputStream out=getContentResolver().openOutputStream(uri,"wt")){out.write(bytes);tell("Export saved. Keep it somewhere private.");}catch(Exception e){tell("Export failed. Your local memory is unchanged.");}});}
    }
    if(requestCode==12 && resultCode==RESULT_OK && data!=null){Uri uri=data.getData();network.execute(()->{
      try{
        String name="backup.json";
        try(android.database.Cursor cursor=getContentResolver().query(uri,new String[]{android.provider.OpenableColumns.DISPLAY_NAME},null,null,null)){
          if(cursor!=null && cursor.moveToFirst())name=cursor.getString(0);
        }
        String raw=new String(bounded(getContentResolver().openInputStream(uri),4*1024*1024),StandardCharsets.UTF_8);
        JSONObject value=new JSONObject().put("name",name).put("raw",raw);
        js("window.auroraImport && window.auroraImport("+value.toString()+")");
      }catch(Exception e){tell("Could not read that file. Choose a Markdown note or an Aurora backup smaller than 4 MB.");}
    });}
  }
  public class Bridge {
    @JavascriptInterface public boolean hasKey(){return prefs.contains("key");}
    @JavascriptInterface public String takeShared(){String value=shared;shared="";return value;}
    @JavascriptInterface public void importFile(){runOnUiThread(()->{
      try{startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE),12);}catch(Exception e){tell("No file picker is available.");}
    });}
    @JavascriptInterface public void configureKey(){runOnUiThread(()->{
      EditText input=new EditText(MainActivity.this);input.setSingleLine(true);input.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);input.setHint("Your Gemini API key");input.setAutofillHints(View.AUTOFILL_HINT_PASSWORD);
      new AlertDialog.Builder(MainActivity.this).setTitle("Gemini API key").setMessage("Use your own free-tier project without billing. The key is encrypted with Android Keystore and is never included in backups.").setView(input).setPositiveButton("Save",(d,w)->{
        String value=input.getText().toString().trim();input.setText("");
        if(!value.matches("[A-Za-z0-9_-]{20,200}")){tell("That key format is not valid.");return;}
        try{storeKey(value);js("window.auroraKeyChanged && window.auroraKeyChanged()");tell("Key saved. No request was sent.");}catch(Exception e){tell("Could not securely store the key.");}
      }).setNegativeButton("Cancel",null).show();
    });}
    @JavascriptInterface public void removeKey(){boolean ok=prefs.edit().remove("key").commit();tell(ok?"Saved key removed.":"Could not remove the key.");js("window.auroraKeyChanged && window.auroraKeyChanged()");}
    @JavascriptInterface public void generate(String id,String raw){
      if(id==null || !id.matches("[a-zA-Z0-9-]{1,80}") || raw==null || raw.length()>80000){result(id,null,"Invalid request.");return;}
      synchronized(requestLock){if(activeId!=null){result(id,null,"Another reply is still stopping. Wait a moment before sending again.");return;}activeId=id;}
      network.execute(()->request(id,raw));
    }
    @JavascriptInterface public void cancel(){synchronized(requestLock){if(connection!=null)connection.disconnect();activeId=null;connection=null;}}
    @JavascriptInterface public void exportFile(String name,String raw){if(raw==null||raw.length()>4*1024*1024)return;export("aurora-mobile-backup.json",raw.getBytes(StandardCharsets.UTF_8),"application/json");}
    @JavascriptInterface public void exportMarkdown(String raw){
      try{if(raw==null||raw.length()>4*1024*1024)throw new IOException();JSONArray notes=new JSONObject(raw).getJSONArray("notes");if(notes.length()>1000)throw new IOException();
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();try(ZipOutputStream zip=new ZipOutputStream(bytes)){
          for(int i=0;i<notes.length();i++){JSONObject note=notes.getJSONObject(i);String path=note.getString("path");
            if(path.length()>220||!path.endsWith(".md")||path.startsWith("/")||path.contains("\\")||path.matches(".*[\\x00-\\x1f].*"))throw new IOException();
            for(String p:path.split("/",-1))if(p.isEmpty()||p.startsWith("."))throw new IOException();
            zip.putNextEntry(new ZipEntry(path));zip.write(note.getString("content").getBytes(StandardCharsets.UTF_8));zip.closeEntry();
          }
        }export("aurora-memory.zip",bytes.toByteArray(),"application/zip");
      }catch(Exception e){tell("Could not prepare Markdown export.");}
    }
    @JavascriptInterface public void speak(String text){runOnUiThread(()->{if(!speechReady){tell("Android speech is not ready. Check your text-to-speech settings.");return;}speech.stop();speech.speak(text.substring(0,Math.min(text.length(),TextToSpeech.getMaxSpeechInputLength())),TextToSpeech.QUEUE_FLUSH,null,"aurora-reading");});}
    @JavascriptInterface public void stopSpeech(){runOnUiThread(()->{if(speech!=null)speech.stop();});}
  }
  @Override protected void onPause(){if(speech!=null)speech.stop();super.onPause();}
  @Override protected void onDestroy(){new Bridge().cancel();network.shutdownNow();if(speech!=null)speech.shutdown();if(web!=null){web.removeJavascriptInterface("AuroraNative");web.destroy();web=null;}super.onDestroy();}
}
