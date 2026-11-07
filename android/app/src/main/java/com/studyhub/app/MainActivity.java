package com.studyhub.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NearbySharePlugin.class);   // Share nearby (www/nearby.js)
        super.onCreate(savedInstanceState);
    }
}
